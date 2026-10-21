/**
 * Expo Push API client — sends push notifications to the mobile
 * companion app (Apps/Braavo). We talk to https://exp.host/--/api/v2/push/send
 * directly rather than pulling in `expo-server-sdk` because:
 *
 *   1. The SDK is a thin wrapper over the same HTTP API
 *   2. We only use a tiny slice of it (batch send, receipt sweep)
 *   3. Fewer transitive deps in production
 *
 * Pipeline:
 *   1. notifyUsers(...) collects the user's enabled prefs + devices
 *   2. Splits into ≤100-message chunks (Expo's hard limit)
 *   3. POSTs each chunk to /push/send
 *   4. Inspects each ticket — if `DeviceNotRegistered`, deletes that
 *      device row so we stop sending to dead tokens
 *
 * Receipts (the second-stage delivery confirmation Expo offers via
 * /push/getReceipts) are intentionally NOT polled here — that's a
 * background-job concern and the immediate ticket already tells us
 * about the most common failure (revoked / unregistered token). If we
 * later want to detect APNs/FCM-side delivery failures we add a
 * scheduled job that polls receipts and prunes accordingly.
 */
import { prisma } from "../lib/db";
import { currentPushDevices, withCurrentPushDelivery, type PushDevice } from "../lib/pushOwnership";
import { logger } from "../lib/logger";
import { notificationText, type NotificationDescriptor } from "../lib/notificationCopy";

const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH = 100;

export type NotifyKind = "approval" | "risk" | "draft" | "run" | "company";

export interface NotifyPayload {
  title: string;
  body: string;
  /** Routed to the mobile app's `usePushNotifications` deep-link mapper. */
  data: { kind: NotifyKind; id?: string; [k: string]: unknown };
  /** iOS only — leaves the app badge as-is when omitted. */
  badge?: number;
  /** Platform-authored framing; user/model content remains the literal body. */
  localized?: NotificationDescriptor;
}

type NotificationDevice = PushDevice;

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket[];
  errors?: Array<{ code: string; message: string }>;
}

/**
 * Resolve every device that should be notified for a given user × kind,
 * filtered by the user's NotificationPref. Returns an empty list (silently)
 * if push is disabled, the user has no devices, or the user's prefs row
 * doesn't exist yet — we treat the absence of a prefs row as "use the
 * defaults" (approvals + risks on, runs + drafts off).
 */
async function devicesForUserKind(
  userId: string,
  kind: NotifyKind,
): Promise<NotificationDevice[]> {
  const prefs = await prisma.notificationPref.findUnique({
    where: { userId },
  });

  // Defaults match the schema column defaults — keep these in sync if
  // you ever rebalance the signal/noise tradeoff.
  const allowed = (() => {
    if (!prefs) {
      return kind === "approval" || kind === "risk";
    }
    if (kind === "approval") return prefs.approvals;
    if (kind === "risk") return prefs.risks;
    if (kind === "draft") return prefs.drafts;
    if (kind === "run") return prefs.runs;
    // `company` is informational — opt in via runs flag.
    return prefs.runs;
  })();

  if (!allowed) return [];

  // Legacy rows and superseded accounts cannot receive new server pushes.
  return currentPushDevices(userId);
}

/**
 * High-level entry point. Pass a tenant ID and a notify kind, and we
 * will fan out to every user in the tenant whose prefs allow the kind.
 *
 * Errors are caught and logged — push failures must NEVER break the
 * upstream business operation (creating an approval, logging a risk,
 * publishing a draft). If Expo is down or the network is partitioned
 * we just skip the notification; the user will still see the change in
 * the app via the polling fallback.
 */
export async function notifyTenantUsers(
  tenantId: string,
  kind: NotifyKind,
  payload: NotifyPayload,
): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: { id: true },
    });
    if (users.length === 0) return;

    const allDevices: NotificationDevice[] = [];
    for (const u of users) {
      const ds = await devicesForUserKind(u.id, kind);
      allDevices.push(...ds);
    }

    if (allDevices.length === 0) return;

    await dispatch(allDevices, payload);
  } catch (err) {
    logger.warn(
      { err, tenantId, kind, title: payload.title },
      "Push notification dispatch failed (non-fatal)",
    );
  }
}

/**
 * Same shape but targets a single user — used when an event is scoped
 * to one specific account (e.g. a draft addressed to that user, not
 * the whole tenant).
 */
export async function notifyUser(
  userId: string,
  kind: NotifyKind,
  payload: NotifyPayload,
): Promise<void> {
  try {
    const devices = await devicesForUserKind(userId, kind);
    if (devices.length === 0) return;
    await dispatch(devices, payload);
  } catch (err) {
    logger.warn(
      { err, userId, kind, title: payload.title },
      "Push notification dispatch failed (non-fatal)",
    );
  }
}

async function dispatch(devices: NotificationDevice[], payload: NotifyPayload) {
  for (let i = 0; i < devices.length; i += MAX_BATCH) {
    await withCurrentPushDelivery(devices.slice(i, i + MAX_BATCH), async live => {
      const messages = live.map(d => ({
        to: d.pushToken, sound: "default" as const,
        title: payload.localized ? notificationText(d.locale, payload.localized.title, payload.localized.parameters) : payload.title,
        body: payload.localized?.body ? notificationText(d.locale, payload.localized.body, payload.localized.parameters) : payload.body,
        data: payload.data, ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
        priority: payload.data.kind === "approval" || payload.data.kind === "risk" ? "high" as const : "default" as const,
        channelId: payload.data.kind === "approval" ? "approvals" : payload.data.kind === "risk" ? "risks" : "default",
      }));
      const response = await fetch(EXPO_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
        body: JSON.stringify(messages), signal: AbortSignal.timeout(5000),
      });
      const json = await response.json().catch(() => ({})) as ExpoPushResponse;
      if (json.errors?.length) { logger.warn({ errors: json.errors }, "Expo push API returned top-level errors"); return []; }
      const dead: PushDevice[] = [];
      (json.data ?? []).forEach((ticket, index) => {
        if (ticket.status !== "error" || !live[index]) return;
        if (ticket.details?.error === "DeviceNotRegistered") dead.push(live[index]!);
        else logger.warn({ ticket, deviceId: live[index]!.id }, "Expo push ticket reported error");
      });
      // The adapter prunes these exact session/revision snapshots while the
      // delivery/ownership locks remain held; opaque high-water fences survive.
      return dead;
    });
  }
}
