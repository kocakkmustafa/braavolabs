/**
 * Relay session bus — Redis pub/sub + capped replay buffer, mirroring
 * lib/runEvents.ts's idiom exactly, doubled for both directions of the
 * relay control plane:
 *
 *   events:   LOCAL session  → companion   (relay:sess:events:{tenantId}:{id})
 *   commands: companion      → LOCAL session (relay:sess:cmds:{tenantId}:{id})
 *
 * Each direction gets its own per-session monotonic `seq` (Redis INCR,
 * doubling as the SSE event-id / Last-Event-ID resume cursor) and its own
 * capped, TTL'd replay buffer — same BUFFER_MAX/TTL constants as runs.
 * Both publish functions redact the payload's free-text fields (see
 * protocol.ts) before it ever touches Redis.
 *
 * TENANT-NAMESPACED KEYS (adversarial review P1, layer 2 of 2): every Redis
 * key here is keyed by `{tenantId}:{sessionId}`, not sessionId alone. The
 * in-memory session registry (relay.core.ts) resets on a process restart,
 * but these Redis buffers survive it (TTL 3600s). Layer 1 of the P1 fix
 * (crypto-random session ids, router.ts) makes a sessionId collision across
 * process generations astronomically unlikely — but layer 1 alone still
 * left a single-sessionId-keyed buffer that WOULD leak a prior tenant's
 * events to whichever tenant next happens to hold that id, if it ever did
 * collide. Namespacing by tenantId closes that even if layer 1 somehow
 * fails: a buffer written under `tenant-a`'s key is simply a different
 * Redis key than the one `tenant-b`'s same-named session reads from, full
 * stop — no reliance on id uniqueness for the isolation guarantee.
 */
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import {
  redactSessionEventInput,
  redactControlCommand,
  type SessionEvent,
  type SessionEventInput,
  type ControlCommand,
  type ControlCommandMessage,
} from "./protocol";

const BUFFER_MAX = 250;
const TTL_SECONDS = 3600;

const ns = (tenantId: string, sessionId: string) => `${tenantId}:${sessionId}`;

const EVENTS_CHANNEL = (tenantId: string, sessionId: string) => `relay:sess:events:${ns(tenantId, sessionId)}`;
const EVENTS_BUFFER_KEY = (tenantId: string, sessionId: string) => `relay:sess:events:buf:${ns(tenantId, sessionId)}`;
const EVENTS_SEQ_KEY = (tenantId: string, sessionId: string) => `relay:sess:events:seq:${ns(tenantId, sessionId)}`;

const CMDS_CHANNEL = (tenantId: string, sessionId: string) => `relay:sess:cmds:${ns(tenantId, sessionId)}`;
const CMDS_BUFFER_KEY = (tenantId: string, sessionId: string) => `relay:sess:cmds:buf:${ns(tenantId, sessionId)}`;
const CMDS_SEQ_KEY = (tenantId: string, sessionId: string) => `relay:sess:cmds:seq:${ns(tenantId, sessionId)}`;

export const relayEventChannel = EVENTS_CHANNEL;
export const relayCommandChannel = CMDS_CHANNEL;

/**
 * Redact, assign envelope (sessionId + monotonic seq + ts), buffer, and
 * publish a session event. Never throws — losing a mirrored observability
 * event is lower severity than losing a control command (see
 * publishControlCommand below, which DOES report delivery status).
 */
export async function publishSessionEvent(sessionId: string, tenantId: string, input: SessionEventInput): Promise<void> {
  try {
    const redacted = redactSessionEventInput(input);
    const seq = await redis.incr(EVENTS_SEQ_KEY(tenantId, sessionId));
    if (seq === 1) await redis.expire(EVENTS_SEQ_KEY(tenantId, sessionId), TTL_SECONDS);
    const full = { ...redacted, sessionId, seq, ts: new Date().toISOString() } as SessionEvent;
    const payload = JSON.stringify(full);
    const buf = EVENTS_BUFFER_KEY(tenantId, sessionId);
    await redis
      .multi()
      .rpush(buf, payload)
      .ltrim(buf, -BUFFER_MAX, -1)
      .expire(buf, TTL_SECONDS)
      .publish(EVENTS_CHANNEL(tenantId, sessionId), payload)
      .exec();
  } catch (err) {
    logger.warn(
      { sessionId, tenantId, type: input.type, err: (err as Error).message },
      "publishSessionEvent failed (non-fatal)",
    );
  }
}

/** Replay buffered session events with seq greater than `afterSeq` (0 = all). Never throws. */
export async function getBufferedSessionEvents(sessionId: string, tenantId: string, afterSeq = 0): Promise<SessionEvent[]> {
  try {
    const raw = await redis.lrange(EVENTS_BUFFER_KEY(tenantId, sessionId), 0, -1);
    const evs = raw.map((r) => JSON.parse(r) as SessionEvent);
    return afterSeq > 0 ? evs.filter((e) => e.seq > afterSeq) : evs;
  } catch (err) {
    logger.warn({ sessionId, tenantId, err: (err as Error).message }, "getBufferedSessionEvents failed (non-fatal)");
    return [];
  }
}

/**
 * Redact, assign envelope, buffer, and publish a control command aimed at
 * the LOCAL session. Returns whether the publish actually succeeded
 * (adversarial review P2-3): unlike publishSessionEvent, a control command
 * changes agent behavior — a silently-lost `kill` leaves the companion
 * believing the session ended while the local agent keeps running, and a
 * silently-lost `approve`/`reject` leaves a governed action stuck forever.
 * Still never THROWS (a Redis blip must not crash the request handler) —
 * failure is reported via the boolean return, and the router turns a
 * `false` into an honest 503 instead of a false-positive 202.
 */
export async function publishControlCommand(sessionId: string, tenantId: string, cmd: ControlCommand): Promise<boolean> {
  try {
    const redacted = redactControlCommand(cmd);
    const seq = await redis.incr(CMDS_SEQ_KEY(tenantId, sessionId));
    if (seq === 1) await redis.expire(CMDS_SEQ_KEY(tenantId, sessionId), TTL_SECONDS);
    const full = { ...redacted, sessionId, seq, ts: new Date().toISOString() } as ControlCommandMessage;
    const payload = JSON.stringify(full);
    const buf = CMDS_BUFFER_KEY(tenantId, sessionId);
    await redis
      .multi()
      .rpush(buf, payload)
      .ltrim(buf, -BUFFER_MAX, -1)
      .expire(buf, TTL_SECONDS)
      .publish(CMDS_CHANNEL(tenantId, sessionId), payload)
      .exec();
    return true;
  } catch (err) {
    logger.warn(
      { sessionId, tenantId, type: cmd.type, err: (err as Error).message },
      "publishControlCommand failed — command NOT delivered",
    );
    return false;
  }
}

/** Replay buffered commands with seq greater than `afterSeq` (0 = all). Never throws. */
export async function getBufferedControlCommands(sessionId: string, tenantId: string, afterSeq = 0): Promise<ControlCommandMessage[]> {
  try {
    const raw = await redis.lrange(CMDS_BUFFER_KEY(tenantId, sessionId), 0, -1);
    const cmds = raw.map((r) => JSON.parse(r) as ControlCommandMessage);
    return afterSeq > 0 ? cmds.filter((c) => c.seq > afterSeq) : cmds;
  } catch (err) {
    logger.warn({ sessionId, tenantId, err: (err as Error).message }, "getBufferedControlCommands failed (non-fatal)");
    return [];
  }
}
