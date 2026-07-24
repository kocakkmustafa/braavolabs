/**
 * Relay control-plane transport — mounted at /api/v1/relay (index.ts).
 *
 * Cloud side of the "Claude Code mobile panel" model: a LOCAL session
 * (desktop app or CLI, Lane-A/B / R6 computer-use running on the user's own
 * machine) registers itself, then mirrors its activity up as SessionEvents
 * and drains ControlCommands a companion (mobile) sends down. This process
 * never runs anything itself — it is a tenant- and OWNER-scoped mirror +
 * mailbox (owner-binding rationale: see relay.core.ts header).
 *
 * Every handler enforces tenant+owner scope through relay.core's pure
 * functions (canAccessSession / authorizeCommand) — see that file for the
 * actual isolation logic. A session that doesn't exist, one that exists but
 * belongs to another tenant, and one that exists in the SAME tenant but was
 * registered by a different user all collapse to the same 404 here, so a
 * probing caller can't learn which case they hit (cross-tenant/cross-user
 * leak = P1/P2 per the adversarial review).
 *
 * First-slice scope (see module report for the full list): the session
 * REGISTRY (`relayState`) is in-memory per API process — fine for a single
 * instance; horizontally scaling this transport needs either sticky
 * routing or moving `RelayState` into Redis (relay.core's functions don't
 * need to change shape to do that later). The event/command CHANNELS
 * already run over Redis pub/sub, so they already fan out across processes.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import {
  SessionRegistrationSchema,
  SessionEventInputSchema,
  ControlCommandSchema,
  type SessionEvent,
  type ControlCommandMessage,
} from "./protocol";
import {
  createRelayState,
  registerSession,
  canAccessSession,
  authorizeCommand,
  endSession,
  getSession,
  listSessions,
  type RelayState,
  type SessionIdGenerator,
} from "./relay.core";
import {
  publishSessionEvent,
  getBufferedSessionEvents,
  relayEventChannel,
  publishControlCommand,
  getBufferedControlCommands,
  relayCommandChannel,
} from "./bus";

export const relayRouter = Router();
relayRouter.use(authMiddleware);

// Process-wide session registry for this first slice — exported so tests
// (and, later, an admin/diagnostics surface) can inspect it directly
// without reaching through HTTP.
export const relayState: RelayState = createRelayState();

// PRODUCTION session-id generator (adversarial review P1, layer 1 of 2):
// cryptographically random, so a session id can never collide across
// process restarts/generations even though `relayState` itself resets to
// empty on restart. relay.core.ts intentionally does NOT import `crypto`
// (kept pure/dependency-free) — this is the app-layer injection point. See
// relay.core.ts's mintSessionId doc for the full incident writeup and layer
// 2 (tenant-namespaced Redis buffer keys, bus.ts).
const cryptoMintId: SessionIdGenerator = () => `sess_${randomUUID()}`;

// P2-4 DoS guard (c): cap concurrent SSE connections per tenant — a
// registered-session cap alone doesn't stop one tenant from opening an
// unbounded number of long-lived stream connections against a handful of
// sessions. Simple in-memory counters are enough for this single-process
// slice.
const MAX_CONCURRENT_SSE_PER_TENANT = 20;
const liveSseByTenant = new Map<string, number>();

function tryAcquireSseSlot(tenantId: string): boolean {
  const current = liveSseByTenant.get(tenantId) ?? 0;
  if (current >= MAX_CONCURRENT_SSE_PER_TENANT) return false;
  liveSseByTenant.set(tenantId, current + 1);
  return true;
}

function releaseSseSlot(tenantId: string): void {
  const current = liveSseByTenant.get(tenantId) ?? 0;
  liveSseByTenant.set(tenantId, Math.max(0, current - 1));
}

// POST /relay/sessions — a LOCAL session (desktop/CLI) registers itself.
relayRouter.post("/sessions", (req, res, next) => {
  try {
    const reg = SessionRegistrationSchema.parse(req.body);
    const result = registerSession(relayState, req.auth!.tenantId, req.auth!.userId, reg, { mintId: cryptoMintId });
    if (!result.ok) {
      // P2-4: per-tenant session cap exceeded even after evicting ended
      // sessions — genuinely too many ACTIVE sessions for this tenant.
      throw new AppError(429, "Too many active relay sessions for this workspace. End an existing session first.");
    }
    res.status(201).json({
      sessionId: result.sessionId,
      surface: result.record.surface,
      label: result.record.label,
      status: result.record.status,
      createdAt: result.record.createdAt,
    });
  } catch (err) { next(err); }
});

// GET /relay/sessions — the CALLING USER's own active/known sessions, for
// the companion to pick one to observe/steer. Owner-scoped (relay.core.ts
// listSessions doc) — never another tenant's OR another user's rows, even
// within the same tenant.
relayRouter.get("/sessions", (req, res, next) => {
  try {
    const sessions = listSessions(relayState, req.auth!.tenantId, req.auth!.userId);
    res.json({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        surface: s.surface,
        label: s.label,
        cwd: s.cwd,
        status: s.status,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) { next(err); }
});

// POST /relay/sessions/:id/events — the LOCAL session publishes a
// SessionEvent. zod parse (malformed → 400) → owner-check (cross-tenant OR
// cross-user-same-tenant/unknown → 404, no existence leak) → publish (bus
// redacts + buffers + fans out over Redis; never throws, so this always
// 202s once authorized). The owner-check doubles as the impersonation guard
// (P2-2): only the SAME user who registered the session may post events as
// it — a different tenant member can't inject fake approval-request/output
// events into someone else's mirror.
relayRouter.post("/sessions/:id/events", async (req, res, next) => {
  try {
    const sessionId = req.params.id as string;
    const parsed = SessionEventInputSchema.parse(req.body);

    if (!canAccessSession(relayState, req.auth!.tenantId, req.auth!.userId, sessionId)) {
      throw new AppError(404, "Session not found");
    }

    await publishSessionEvent(sessionId, req.auth!.tenantId, parsed);

    // The local session reporting its own graceful end is the authoritative
    // lifecycle signal (a `kill` ControlCommand only REQUESTS this — see the
    // /commands handler below, which also marks the session ended so no
    // further commands are authorized against it either way).
    if (parsed.type === "status" && parsed.state === "ended") {
      endSession(relayState, sessionId);
    }

    res.status(202).json({ success: true });
  } catch (err) { next(err); }
});

// GET /relay/sessions/:id/events (SSE) — companion subscribes to a
// session's event stream. Same Redis pub/sub + Last-Event-ID resume idiom
// as GET /runs/:id/stream (subscribe first, buffer live messages until the
// backlog replay is flushed, then drain — avoids both gaps and duplicates).
relayRouter.get("/sessions/:id/events", async (req, res) => {
  const sessionId = req.params.id as string;
  const tenantId = req.auth!.tenantId;
  if (!canAccessSession(relayState, tenantId, req.auth!.userId, sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (!tryAcquireSseSlot(tenantId)) {
    res.status(429).json({ error: "Too many concurrent relay streams for this workspace." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  const lastEventId = Number(req.headers["last-event-id"] ?? req.query.lastEventId ?? 0) || 0;
  let closed = false;
  let maxSeqWritten = lastEventId;
  const sub = redis.duplicate();

  function cleanup() {
    if (closed) return;
    closed = true;
    releaseSseSlot(tenantId);
    clearInterval(heartbeat);
    sub.removeAllListeners("message");
    sub.unsubscribe(relayEventChannel(tenantId, sessionId)).catch(() => {});
    sub.quit().catch(() => {});
    try { res.end(); } catch { /* already ended */ }
  }

  const write = (ev: SessionEvent) => {
    if (closed || ev.seq <= maxSeqWritten) return;
    maxSeqWritten = ev.seq;
    res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === "status" && ev.state === "ended") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  };

  const pending: SessionEvent[] = [];
  let backlogFlushed = false;
  sub.on("message", (_ch: string, msg: string) => {
    try {
      const ev = JSON.parse(msg) as SessionEvent;
      if (backlogFlushed) write(ev);
      else pending.push(ev);
    } catch {
      /* ignore malformed */
    }
  });

  // nginx/CDNs idle-timeout silent connections; a comment line every 25s
  // keeps the socket alive (": " prefix = ignored per the EventSource spec).
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { cleanup(); }
  }, 25_000);

  req.on("close", cleanup);

  try {
    await sub.subscribe(relayEventChannel(tenantId, sessionId));
    for (const ev of await getBufferedSessionEvents(sessionId, tenantId, lastEventId)) write(ev);
    backlogFlushed = true;
    for (const ev of pending.splice(0)) write(ev);

    // Already-ended session with nothing more coming → close after replay.
    const record = getSession(relayState, sessionId);
    if (!closed && record?.status === "ended") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  } catch (err) {
    logger.warn({ sessionId, tenantId, err: (err as Error).message }, "relay event stream subscribe failed");
    cleanup();
  }
});

// GET /relay/sessions/:id/events/poll?after=<seq> — a JSON poll of buffered
// events for clients that can't hold an SSE stream. React Native's fetch has
// no EventSource and no streaming response body, so the mobile companion
// polls this instead of subscribing. Same owner-binding gate + buffer source
// as the SSE endpoint (canAccessSession → getBufferedSessionEvents); returns
// the events after `after`, the highest seq seen, and whether the session has
// ended (so the poller knows to stop).
relayRouter.get("/sessions/:id/events/poll", async (req, res) => {
  const sessionId = req.params.id as string;
  const tenantId = req.auth!.tenantId;
  if (!canAccessSession(relayState, tenantId, req.auth!.userId, sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const after = Number(req.query.after ?? 0) || 0;
  const events = await getBufferedSessionEvents(sessionId, tenantId, after);
  const lastSeq = events.length ? events[events.length - 1]!.seq : after;
  const record = getSession(relayState, sessionId);
  res.json({ events, lastSeq, ended: record?.status === "ended" });
});

// POST /relay/sessions/:id/commands — the companion sends a ControlCommand.
// zod parse (malformed → 400) → authorizeCommand (owner/lifecycle/kind →
// 404, no existence leak) → publish, CHECKING delivery (adversarial review
// P2-3: a silently-lost command must not look like a success — see
// publishControlCommand's doc). `kill` only marks the session ended AFTER a
// confirmed publish, so the companion is never told "ended" while the
// local session never actually received the kill.
relayRouter.post("/sessions/:id/commands", async (req, res, next) => {
  try {
    const sessionId = req.params.id as string;
    const parsed = ControlCommandSchema.parse(req.body);

    const authz = authorizeCommand(relayState, req.auth!.tenantId, req.auth!.userId, sessionId, parsed);
    if (!authz.ok) {
      throw new AppError(404, "Session not found or not steerable");
    }

    const delivered = await publishControlCommand(sessionId, req.auth!.tenantId, parsed);
    if (!delivered) {
      throw new AppError(503, "Command could not be delivered — try again.");
    }

    if (parsed.type === "kill") {
      endSession(relayState, sessionId);
    }

    res.status(202).json({ success: true });
  } catch (err) { next(err); }
});

// GET /relay/sessions/:id/commands (SSE) — the LOCAL session subscribes to
// its own inbound command stream. Same idiom as the events stream above.
relayRouter.get("/sessions/:id/commands", async (req, res) => {
  const sessionId = req.params.id as string;
  const tenantId = req.auth!.tenantId;
  if (!canAccessSession(relayState, tenantId, req.auth!.userId, sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (!tryAcquireSseSlot(tenantId)) {
    res.status(429).json({ error: "Too many concurrent relay streams for this workspace." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  const lastEventId = Number(req.headers["last-event-id"] ?? req.query.lastEventId ?? 0) || 0;
  let closed = false;
  let maxSeqWritten = lastEventId;
  const sub = redis.duplicate();

  function cleanup() {
    if (closed) return;
    closed = true;
    releaseSseSlot(tenantId);
    clearInterval(heartbeat);
    sub.removeAllListeners("message");
    sub.unsubscribe(relayCommandChannel(tenantId, sessionId)).catch(() => {});
    sub.quit().catch(() => {});
    try { res.end(); } catch { /* already ended */ }
  }

  const write = (cmd: ControlCommandMessage) => {
    if (closed || cmd.seq <= maxSeqWritten) return;
    maxSeqWritten = cmd.seq;
    res.write(`id: ${cmd.seq}\ndata: ${JSON.stringify(cmd)}\n\n`);
    if (cmd.type === "kill") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  };

  const pending: ControlCommandMessage[] = [];
  let backlogFlushed = false;
  sub.on("message", (_ch: string, msg: string) => {
    try {
      const cmd = JSON.parse(msg) as ControlCommandMessage;
      if (backlogFlushed) write(cmd);
      else pending.push(cmd);
    } catch {
      /* ignore malformed */
    }
  });

  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { cleanup(); }
  }, 25_000);

  req.on("close", cleanup);

  try {
    await sub.subscribe(relayCommandChannel(tenantId, sessionId));
    for (const cmd of await getBufferedControlCommands(sessionId, tenantId, lastEventId)) write(cmd);
    backlogFlushed = true;
    for (const cmd of pending.splice(0)) write(cmd);

    const record = getSession(relayState, sessionId);
    if (!closed && record?.status === "ended") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  } catch (err) {
    logger.warn({ sessionId, tenantId, err: (err as Error).message }, "relay command stream subscribe failed");
    cleanup();
  }
});
