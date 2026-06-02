/**
 * Run event bus — Redis pub/sub + a capped replay buffer.
 *
 * `publishRunEvent()` is called from the pipeline runner/executor at each
 * lifecycle point; the SSE endpoint (GET /runs/:id/stream) subscribes to the
 * per-run channel for real-time delivery and replays the buffer on reconnect
 * via `Last-Event-ID`. This replaces the previous 3-second Postgres polling.
 *
 * Design notes:
 *  - `seq` is a per-run monotonic counter (Redis INCR) and doubles as the SSE
 *    event id / Last-Event-ID resume cursor.
 *  - The buffer is a capped list (last BUFFER_MAX events) with a TTL, so a
 *    client reconnecting within the window misses nothing.
 *  - `publishRunEvent` NEVER throws — a Redis blip must not break a run.
 */
import { redis } from "./redis";
import { logger } from "./logger";
import type { RunEvent } from "@ai-company-os/core";

// Built-in Omit isn't distributive over unions; this one is, so callers get
// per-member type-safety when constructing an event without the envelope.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type RunEventInput = DistributiveOmit<RunEvent, "runId" | "seq" | "ts">;

const CHANNEL = (runId: string) => `run:events:${runId}`;
const BUFFER_KEY = (runId: string) => `run:events:buf:${runId}`;
const SEQ_KEY = (runId: string) => `run:events:seq:${runId}`;
const BUFFER_MAX = 250;
const TTL_SECONDS = 3600;

export const runEventChannel = CHANNEL;

/** Assign envelope (runId + monotonic seq + ts), buffer, and publish. Never throws. */
export async function publishRunEvent(runId: string, ev: RunEventInput): Promise<void> {
  try {
    const seq = await redis.incr(SEQ_KEY(runId));
    if (seq === 1) await redis.expire(SEQ_KEY(runId), TTL_SECONDS);
    const full = { ...ev, runId, seq, ts: new Date().toISOString() } as RunEvent;
    const payload = JSON.stringify(full);
    const buf = BUFFER_KEY(runId);
    await redis
      .multi()
      .rpush(buf, payload)
      .ltrim(buf, -BUFFER_MAX, -1)
      .expire(buf, TTL_SECONDS)
      .publish(CHANNEL(runId), payload)
      .exec();
  } catch (err) {
    logger.warn({ runId, type: ev.type, err: (err as Error).message }, "publishRunEvent failed (non-fatal)");
  }
}

/** Replay buffered events with seq greater than `afterSeq` (0 = all). Never throws. */
export async function getBufferedRunEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
  try {
    const raw = await redis.lrange(BUFFER_KEY(runId), 0, -1);
    const evs = raw.map((r) => JSON.parse(r) as RunEvent);
    return afterSeq > 0 ? evs.filter((e) => e.seq > afterSeq) : evs;
  } catch (err) {
    logger.warn({ runId, err: (err as Error).message }, "getBufferedRunEvents failed (non-fatal)");
    return [];
  }
}
