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
import { logger } from "../lib/logger";

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
}

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
): Promise<{ pushToken: string; id: string }[]> {
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

  return prisma.device.findMany({
    where: { userId },
    select: { id: true, pushToken: true },
  });
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

    const allDevices: { pushToken: string; id: string }[] = [];
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

async function dispatch(
  devices: { pushToken: string; id: string }[],
  payload: NotifyPayload,
) {
  const messages = devices.map((d) => ({
    to: d.pushToken,
    sound: "default" as const,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    // `priority: "high"` makes Android wake the device immediately
    // (otherwise FCM may batch). Critical for approval / risk events.
    priority:
      payload.data.kind === "approval" || payload.data.kind === "risk"
        ? ("high" as const)
        : ("default" as const),
    // Map our kinds to per-channel Android channels (must match the
    // channel IDs created in Apps/Braavo/lib/notifications.ts).
    channelId:
      payload.data.kind === "approval"
        ? "approvals"
        : payload.data.kind === "risk"
        ? "risks"
        : "default",
  }));

  // Chunk to Expo's per-request limit.
  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const chunk = messages.slice(i, i + MAX_BATCH);
    const chunkDevices = devices.slice(i, i + MAX_BATCH);

    const res = await fetch(EXPO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(chunk),
      // 5s — Expo is fast; if it's slower than this something's wrong
      // and we'd rather drop a notification than hold up an HTTP handler.
      signal: AbortSignal.timeout(5000),
    });

    const json = (await res.json().catch(() => ({}))) as ExpoPushResponse;

    if (json.errors?.length) {
      logger.warn({ errors: json.errors }, "Expo push API returned top-level errors");
      continue;
    }

    const tickets = json.data ?? [];
    const deadDeviceIds: string[] = [];

    tickets.forEach((ticket, idx) => {
      if (ticket.status === "error") {
        const code = ticket.details?.error;
        // The token is invalid (uninstalled / restored to another phone /
        // user revoked permission). Drop it from the table so we stop
        // wasting calls on it. Other errors (rate limits, transient
        // network issues) we leave alone.
        if (code === "DeviceNotRegistered") {
          deadDeviceIds.push(chunkDevices[idx]!.id);
        } else {
          logger.warn(
            { ticket, deviceId: chunkDevices[idx]!.id },
            "Expo push ticket reported error",
          );
        }
      }
    });

    if (deadDeviceIds.length > 0) {
      await prisma.device
        .deleteMany({ where: { id: { in: deadDeviceIds } } })
        .catch((err) =>
          logger.warn({ err, deadDeviceIds }, "Failed to prune dead device tokens"),
        );
      logger.info(
        { count: deadDeviceIds.length },
        "Pruned unregistered device push tokens",
      );
    }
  }
}
