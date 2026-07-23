/**
 * Relay session bus — Redis pub/sub + capped replay buffer, mirroring
 * lib/runEvents.ts's idiom exactly, doubled for both directions of the
 * relay control plane:
 *
 *   events:   LOCAL session  → companion   (relay:sess:events:{id})
 *   commands: companion      → LOCAL session (relay:sess:cmds:{id})
 *
 * Each direction gets its own per-session monotonic `seq` (Redis INCR,
 * doubling as the SSE event-id / Last-Event-ID resume cursor) and its own
 * capped, TTL'd replay buffer — same BUFFER_MAX/TTL constants as runs.
 * Both publish functions redact the payload's free-text fields (see
 * protocol.ts) before it ever touches Redis, and — like publishRunEvent —
 * NEVER throw: a Redis blip must not break the local session's loop or the
 * companion's command send.
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

const EVENTS_CHANNEL = (sessionId: string) => `relay:sess:events:${sessionId}`;
const EVENTS_BUFFER_KEY = (sessionId: string) => `relay:sess:events:buf:${sessionId}`;
const EVENTS_SEQ_KEY = (sessionId: string) => `relay:sess:events:seq:${sessionId}`;

const CMDS_CHANNEL = (sessionId: string) => `relay:sess:cmds:${sessionId}`;
const CMDS_BUFFER_KEY = (sessionId: string) => `relay:sess:cmds:buf:${sessionId}`;
const CMDS_SEQ_KEY = (sessionId: string) => `relay:sess:cmds:seq:${sessionId}`;

export const relayEventChannel = EVENTS_CHANNEL;
export const relayCommandChannel = CMDS_CHANNEL;

/**
 * Redact, assign envelope (sessionId + monotonic seq + ts), buffer, and
 * publish a session event. Never throws.
 */
export async function publishSessionEvent(sessionId: string, input: SessionEventInput): Promise<void> {
  try {
    const redacted = redactSessionEventInput(input);
    const seq = await redis.incr(EVENTS_SEQ_KEY(sessionId));
    if (seq === 1) await redis.expire(EVENTS_SEQ_KEY(sessionId), TTL_SECONDS);
    const full = { ...redacted, sessionId, seq, ts: new Date().toISOString() } as SessionEvent;
    const payload = JSON.stringify(full);
    const buf = EVENTS_BUFFER_KEY(sessionId);
    await redis
      .multi()
      .rpush(buf, payload)
      .ltrim(buf, -BUFFER_MAX, -1)
      .expire(buf, TTL_SECONDS)
      .publish(EVENTS_CHANNEL(sessionId), payload)
      .exec();
  } catch (err) {
    logger.warn(
      { sessionId, type: input.type, err: (err as Error).message },
      "publishSessionEvent failed (non-fatal)",
    );
  }
}

/** Replay buffered session events with seq greater than `afterSeq` (0 = all). Never throws. */
export async function getBufferedSessionEvents(sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
  try {
    const raw = await redis.lrange(EVENTS_BUFFER_KEY(sessionId), 0, -1);
    const evs = raw.map((r) => JSON.parse(r) as SessionEvent);
    return afterSeq > 0 ? evs.filter((e) => e.seq > afterSeq) : evs;
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "getBufferedSessionEvents failed (non-fatal)");
    return [];
  }
}

/**
 * Redact, assign envelope, buffer, and publish a control command aimed at
 * the LOCAL session. Never throws.
 */
export async function publishControlCommand(sessionId: string, cmd: ControlCommand): Promise<void> {
  try {
    const redacted = redactControlCommand(cmd);
    const seq = await redis.incr(CMDS_SEQ_KEY(sessionId));
    if (seq === 1) await redis.expire(CMDS_SEQ_KEY(sessionId), TTL_SECONDS);
    const full = { ...redacted, sessionId, seq, ts: new Date().toISOString() } as ControlCommandMessage;
    const payload = JSON.stringify(full);
    const buf = CMDS_BUFFER_KEY(sessionId);
    await redis
      .multi()
      .rpush(buf, payload)
      .ltrim(buf, -BUFFER_MAX, -1)
      .expire(buf, TTL_SECONDS)
      .publish(CMDS_CHANNEL(sessionId), payload)
      .exec();
  } catch (err) {
    logger.warn(
      { sessionId, type: cmd.type, err: (err as Error).message },
      "publishControlCommand failed (non-fatal)",
    );
  }
}

/** Replay buffered commands with seq greater than `afterSeq` (0 = all). Never throws. */
export async function getBufferedControlCommands(sessionId: string, afterSeq = 0): Promise<ControlCommandMessage[]> {
  try {
    const raw = await redis.lrange(CMDS_BUFFER_KEY(sessionId), 0, -1);
    const cmds = raw.map((r) => JSON.parse(r) as ControlCommandMessage);
    return afterSeq > 0 ? cmds.filter((c) => c.seq > afterSeq) : cmds;
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "getBufferedControlCommands failed (non-fatal)");
    return [];
  }
}
