/**
 * Relay session core — SAF (pure) state machine, zero express/Redis
 * dependencies, fully unit-testable in isolation. Every tenant-isolation
 * decision for the relay control plane lives HERE, not in router.ts — the
 * router only wires HTTP/SSE transport around these functions.
 *
 * First slice: sessions live in an in-memory Map (`RelayState`). A single
 * API process holds the registry; the Redis-backed event/command channels
 * (bus.ts) are what let a companion on a different connection (or, once
 * horizontally scaled, a different process reachable via sticky routing)
 * observe them. Migrating `RelayState` itself to Redis is a known follow-up
 * (see module report) — it does not change any function signature below.
 */
import type { ControlCommand, Surface, SessionRegistration } from "./protocol";

export type SessionStatus = "active" | "ended";

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  surface: Surface;
  label?: string;
  cwd?: string;
  status: SessionStatus;
  createdAt: string;
}

export interface RelayState {
  sessions: Map<string, SessionRecord>;
  /** Monotonic counter backing mintSessionId — never Math.random()/Date.now(). */
  counter: number;
}

/** `seedCounter` lets tests get deterministic, reproducible session ids. */
export function createRelayState(seedCounter = 0): RelayState {
  return { sessions: new Map(), counter: seedCounter };
}

/**
 * Mint a collision-free session id. Deterministic given the state's
 * starting counter — no Math.random()/Date.now() — so tests can seed a
 * counter and assert exact ids, and so id generation never depends on wall
 * clock or process entropy.
 */
export function mintSessionId(state: RelayState): string {
  state.counter += 1;
  return `sess_${state.counter.toString(36)}`;
}

/**
 * Register a new LOCAL session for a tenant. Pure aside from mutating the
 * passed-in `state` map/counter. `now` is injectable so tests can pin
 * `createdAt` without depending on wall-clock time (defaults to real time
 * — same convention runEvents.ts uses for its `ts` field).
 */
export function registerSession(
  state: RelayState,
  tenantId: string,
  reg: SessionRegistration,
  now: () => string = () => new Date().toISOString(),
): { sessionId: string; record: SessionRecord } {
  const sessionId = mintSessionId(state);
  const record: SessionRecord = {
    sessionId,
    tenantId,
    surface: reg.surface,
    label: reg.label,
    cwd: reg.cwd,
    status: "active",
    createdAt: now(),
  };
  state.sessions.set(sessionId, record);
  return { sessionId, record };
}

export function getSession(state: RelayState, sessionId: string): SessionRecord | undefined {
  return state.sessions.get(sessionId);
}

/**
 * LOAD-BEARING SECURITY CHECK. A companion (or a local session posting an
 * event) may only touch a session that belongs to its OWN tenant. Unknown
 * session id and cross-tenant session both return false — callers must
 * collapse both to the same 404/403 response so a probe can't distinguish
 * "doesn't exist" from "exists, belongs to someone else" (P1 if it can).
 */
export function canAccessSession(state: RelayState, tenantId: string, sessionId: string): boolean {
  const record = state.sessions.get(sessionId);
  if (!record) return false;
  return record.tenantId === tenantId;
}

export type AuthorizeCommandResult = { ok: true } | { ok: false; reason: string };

const VALID_COMMAND_KINDS: ReadonlySet<ControlCommand["type"]> = new Set(["steer", "approve", "reject", "kill"]);

/**
 * Gate for companion → local-session commands. Enforces, in order:
 *   1. the session exists
 *   2. it belongs to the caller's tenant (cross-tenant = P1, see above)
 *   3. it hasn't ended (a dead session can't be steered/approved/killed again)
 *   4. the command's `type` is one this contract recognizes
 * zod already rejects malformed commands before this is called in the real
 * router, but this stays defensive so calling it directly (as tests do)
 * gives the same answer without relying on that upstream parse.
 */
export function authorizeCommand(
  state: RelayState,
  tenantId: string,
  sessionId: string,
  cmd: ControlCommand,
): AuthorizeCommandResult {
  const record = state.sessions.get(sessionId);
  if (!record) return { ok: false, reason: "session not found" };
  if (record.tenantId !== tenantId) return { ok: false, reason: "session belongs to a different tenant" };
  if (record.status === "ended") return { ok: false, reason: "session has ended" };
  if (!VALID_COMMAND_KINDS.has(cmd.type)) return { ok: false, reason: "unrecognized command kind" };
  return { ok: true };
}

/** Marks a session ended. No-op (not an error) if the id is unknown. */
export function endSession(state: RelayState, sessionId: string): void {
  const record = state.sessions.get(sessionId);
  if (!record) return;
  record.status = "ended";
}

/** Every session belonging to `tenantId`, oldest first. Never another tenant's rows. */
export function listSessions(state: RelayState, tenantId: string): SessionRecord[] {
  return Array.from(state.sessions.values())
    .filter((s) => s.tenantId === tenantId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sessionId.localeCompare(b.sessionId)));
}
