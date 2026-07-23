/**
 * Relay control-plane transport — mounted at /api/v1/relay (index.ts).
 *
 * Cloud side of the "Claude Code mobile panel" model: a LOCAL session
 * (desktop app or CLI, Lane-A/B / R6 computer-use running on the user's own
 * machine) registers itself, then mirrors its activity up as SessionEvents
 * and drains ControlCommands a companion (mobile) sends down. This process
 * never runs anything itself — it is a tenant-scoped mirror + mailbox.
 *
 * Every handler enforces tenant-scope through relay.core's pure functions
 * (canAccessSession / authorizeCommand) — see that file for the actual
 * isolation logic. A session that doesn't exist and a session that exists
 * but belongs to another tenant both collapse to 404 here, so a probing
 * caller can't learn which case they hit (cross-tenant leak = P1).
 *
 * First-slice scope (see module report for the full list): the session
 * REGISTRY (`relayState`) is in-memory per API process — fine for a single
 * instance; horizontally scaling this transport needs either sticky
 * routing or moving `RelayState` into Redis (relay.core's functions don't
 * need to change shape to do that later). The event/command CHANNELS
 * already run over Redis pub/sub, so they already fan out across processes.
 */
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

// POST /relay/sessions — a LOCAL session (desktop/CLI) registers itself.
relayRouter.post("/sessions", (req, res, next) => {
  try {
    const reg = SessionRegistrationSchema.parse(req.body);
    const { sessionId, record } = registerSession(relayState, req.auth!.tenantId, reg);
    res.status(201).json({
      sessionId,
      surface: record.surface,
      label: record.label,
      status: record.status,
      createdAt: record.createdAt,
    });
  } catch (err) { next(err); }
});

// GET /relay/sessions — the tenant's own active/known sessions, for the
// companion to pick one to observe/steer. Never another tenant's rows.
relayRouter.get("/sessions", (req, res, next) => {
  try {
    const sessions = listSessions(relayState, req.auth!.tenantId);
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
// SessionEvent. zod parse (malformed → 400) → tenant-check (cross-tenant/
// unknown → 404, no existence leak) → publish (bus redacts + buffers +
// fans out over Redis; never throws, so this always 202s once authorized).
relayRouter.post("/sessions/:id/events", async (req, res, next) => {
  try {
    const sessionId = req.params.id as string;
    const parsed = SessionEventInputSchema.parse(req.body);

    if (!canAccessSession(relayState, req.auth!.tenantId, sessionId)) {
      throw new AppError(404, "Session not found");
    }

    await publishSessionEvent(sessionId, parsed);

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
  if (!canAccessSession(relayState, req.auth!.tenantId, sessionId)) {
    res.status(404).json({ error: "Session not found" });
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
    clearInterval(heartbeat);
    sub.removeAllListeners("message");
    sub.unsubscribe(relayEventChannel(sessionId)).catch(() => {});
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
    await sub.subscribe(relayEventChannel(sessionId));
    for (const ev of await getBufferedSessionEvents(sessionId, lastEventId)) write(ev);
    backlogFlushed = true;
    for (const ev of pending.splice(0)) write(ev);

    // Already-ended session with nothing more coming → close after replay.
    const record = getSession(relayState, sessionId);
    if (!closed && record?.status === "ended") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "relay event stream subscribe failed");
    cleanup();
  }
});

// POST /relay/sessions/:id/commands — the companion sends a ControlCommand.
// zod parse (malformed → 400) → authorizeCommand (tenant/lifecycle/kind →
// 404, no existence leak) → publish (bus redacts + buffers + fans out).
relayRouter.post("/sessions/:id/commands", async (req, res, next) => {
  try {
    const sessionId = req.params.id as string;
    const parsed = ControlCommandSchema.parse(req.body);

    const authz = authorizeCommand(relayState, req.auth!.tenantId, sessionId, parsed);
    if (!authz.ok) {
      throw new AppError(404, "Session not found or not steerable");
    }

    await publishControlCommand(sessionId, parsed);

    // A kill request ends the relay's view of the session immediately —
    // no further commands should be authorized against it, even if the
    // local process takes a moment to actually exit and report its own
    // `status: ended` event.
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
  if (!canAccessSession(relayState, req.auth!.tenantId, sessionId)) {
    res.status(404).json({ error: "Session not found" });
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
    clearInterval(heartbeat);
    sub.removeAllListeners("message");
    sub.unsubscribe(relayCommandChannel(sessionId)).catch(() => {});
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
    await sub.subscribe(relayCommandChannel(sessionId));
    for (const cmd of await getBufferedControlCommands(sessionId, lastEventId)) write(cmd);
    backlogFlushed = true;
    for (const cmd of pending.splice(0)) write(cmd);

    const record = getSession(relayState, sessionId);
    if (!closed && record?.status === "ended") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "relay command stream subscribe failed");
    cleanup();
  }
});
