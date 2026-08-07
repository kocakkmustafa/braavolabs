/**
 * Onay kuyruğu (`post_queue`) — motorun yayın hattına bakan yüzü.
 *
 * Akış (kurucu kararı 2026-08-07):
 *   enqueue → pending + approval_deadline
 *     ↓ Telegram önizleme + butonlar (telegram.ts)
 *   kurucu ✓ → approved (founder) · ❌ → skipped (ASLA yayınlanmaz)
 *   sessizlik + pencere doldu → auto_approved (timeout)
 *     ↓ publishWithRetry → published/failed + post_log
 *
 * ⚠️ TUZAK (2026-08-07 canlı yakalandı): PostgREST sorgusunda `isoformat()`
 * çıktısındaki `+00:00` URL'de BOŞLUĞA dönüşür ve Postgres 22007 verir.
 * Bu yüzden zaman damgaları `Z` son ekiyle yazılır — `qTime()`.
 */

import { logger } from "../../../lib/logger";
import { socialSupabase } from "./config";
import type { MediaKind, SocialBrand, SocialPlatform } from "./types";

export class QueueError extends Error {}

export const DEFAULT_APPROVAL_WINDOW_HOURS = 24;
export const REMINDER_BEFORE_HOURS = 2;

export interface QueueRow {
  id: number;
  brand: SocialBrand;
  platform: SocialPlatform;
  caption: string;
  media_urls: string[];
  media_kind: MediaKind | null;
  hashtags: string[];
  status: string;
  approval_status: string;
  approval_deadline: string | null;
  approved_by: string | null;
  telegram_msg_id: string | null;
  retries: number;
}

export interface QueueDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** URL-güvenli zaman damgası — `+00:00` yerine `Z` (PostgREST 22007 tuzağı). */
export function qTime(d: Date): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

function headers(): Record<string, string> {
  const { serviceKey } = socialSupabase();
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
}

async function req<T>(
  method: string,
  path: string,
  opts: { body?: unknown; prefer?: string } & QueueDeps = {},
): Promise<T | null> {
  const { url } = socialSupabase();
  const doFetch = opts.fetchImpl ?? fetch;
  const h = { ...headers() };
  if (opts.prefer) h.prefer = opts.prefer;
  let res: Response;
  try {
    res = await doFetch(`${url}/rest/v1/${path}`, {
      method,
      headers: h,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new QueueError(`Supabase ağ hatası: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new QueueError(`Supabase ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface EnqueueInput {
  brand: SocialBrand;
  platform: SocialPlatform;
  caption: string;
  mediaUrls?: string[];
  mediaKind?: MediaKind;
  hashtags?: string[];
  approvalWindowHours?: number;
  notes?: string;
}

export async function enqueue(input: EnqueueInput, deps: QueueDeps = {}): Promise<QueueRow> {
  const now = deps.now?.() ?? new Date();
  const windowH = input.approvalWindowHours ?? DEFAULT_APPROVAL_WINDOW_HOURS;
  const deadline = new Date(now.getTime() + windowH * 3600_000);
  const rows = await req<QueueRow[]>("POST", "post_queue", {
    ...deps,
    prefer: "return=representation",
    body: {
      brand: input.brand,
      platform: input.platform,
      content_type: "post",
      caption: input.caption,
      hashtags: input.hashtags ?? [],
      media_urls: input.mediaUrls ?? [],
      media_kind: input.mediaKind ?? null,
      scheduled_at: now.toISOString(),
      status: "awaiting_approval",
      approval_status: "pending",
      approval_deadline: deadline.toISOString(),
      notes: input.notes ?? null,
    },
  });
  if (!rows?.length) throw new QueueError("enqueue: Supabase kayıt döndürmedi");
  return rows[0];
}

export async function readyToPublish(deps: QueueDeps = {}): Promise<QueueRow[]> {
  const now = qTime(deps.now?.() ?? new Date());
  return (
    (await req<QueueRow[]>(
      "GET",
      `post_queue?status=eq.approved&approval_status=in.(approved,edited,auto_approved)&scheduled_at=lte.${now}&select=*&order=scheduled_at`,
      deps,
    )) ?? []
  );
}

export async function dueForAutoApproval(deps: QueueDeps = {}): Promise<QueueRow[]> {
  const now = qTime(deps.now?.() ?? new Date());
  return (
    (await req<QueueRow[]>(
      "GET",
      `post_queue?approval_status=eq.pending&approval_deadline=lte.${now}&select=*`,
      deps,
    )) ?? []
  );
}

export async function dueForReminder(deps: QueueDeps = {}): Promise<QueueRow[]> {
  const base = deps.now?.() ?? new Date();
  const now = qTime(base);
  const threshold = qTime(new Date(base.getTime() + REMINDER_BEFORE_HOURS * 3600_000));
  return (
    (await req<QueueRow[]>(
      "GET",
      `post_queue?approval_status=eq.pending&reminder_sent_at=is.null&approval_deadline=lte.${threshold}&approval_deadline=gt.${now}&select=*`,
      deps,
    )) ?? []
  );
}

export async function pendingPosts(deps: QueueDeps = {}): Promise<QueueRow[]> {
  return (
    (await req<QueueRow[]>(
      "GET",
      "post_queue?approval_status=eq.pending&select=*&order=approval_deadline",
      deps,
    )) ?? []
  );
}

export async function markApproved(
  id: number,
  by: "founder" | "timeout",
  deps: QueueDeps = {},
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await req("PATCH", `post_queue?id=eq.${id}`, {
    ...deps,
    body: {
      approval_status: by === "founder" ? "approved" : "auto_approved",
      status: "approved",
      approved_by: by,
      approved_at: now.toISOString(),
    },
  });
}

export async function markSkipped(id: number, reason: string, deps: QueueDeps = {}): Promise<void> {
  await req("PATCH", `post_queue?id=eq.${id}`, {
    ...deps,
    body: { approval_status: "skipped", status: "skipped", notes: reason },
  });
}

export async function markReminderSent(id: number, deps: QueueDeps = {}): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await req("PATCH", `post_queue?id=eq.${id}`, {
    ...deps,
    body: { reminder_sent_at: now.toISOString() },
  });
}

export async function markPublished(
  row: QueueRow,
  platformPostId: string | null,
  platformUrl: string | null,
  deps: QueueDeps = {},
): Promise<void> {
  await req("PATCH", `post_queue?id=eq.${row.id}`, {
    ...deps,
    body: { status: "published", last_error: null },
  });
  await logResult(row, "published", platformPostId, platformUrl, null, deps);
}

export async function markFailed(row: QueueRow, error: string, deps: QueueDeps = {}): Promise<void> {
  await req("PATCH", `post_queue?id=eq.${row.id}`, {
    ...deps,
    body: { status: "failed", last_error: error.slice(0, 1000), retries: (row.retries ?? 0) + 1 },
  });
  await logResult(row, "failed", null, null, error, deps);
}

async function logResult(
  row: QueueRow,
  status: "published" | "failed",
  platformPostId: string | null,
  platformUrl: string | null,
  error: string | null,
  deps: QueueDeps,
): Promise<void> {
  try {
    await req("POST", "post_log", {
      ...deps,
      body: {
        post_queue_id: row.id,
        brand: row.brand,
        platform: row.platform,
        platform_post_id: platformPostId,
        platform_url: platformUrl,
        status,
        error_message: error ? error.slice(0, 1000) : null,
      },
    });
  } catch (err) {
    logger.warn({ err, postId: row.id }, "post_log yazılamadı");
  }
}

export async function unprocessedCallbacks(deps: QueueDeps = {}): Promise<
  Array<{ id: number; post_queue_id: number | null; action: string; payload_json: Record<string, unknown> | null }>
> {
  return (
    (await req("GET", "approval_callbacks?processed_at=is.null&select=*&order=created_at", deps)) ?? []
  );
}

export async function markCallbackProcessed(id: number, deps: QueueDeps = {}): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await req("PATCH", `approval_callbacks?id=eq.${id}`, {
    ...deps,
    body: { processed_at: now.toISOString() },
  });
}
