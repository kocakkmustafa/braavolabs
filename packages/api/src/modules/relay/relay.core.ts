/**
 * Relay session core — SAF (pure) state machine, zero express/Redis
 * dependencies, fully unit-testable in isolation. Every tenant- AND
 * OWNER-isolation decision for the relay control plane lives HERE, not in
 * router.ts — the router only wires HTTP/SSE transport around these
 * functions.
 *
 * First slice: sessions live in an in-memory Map (`RelayState`). A single
 * API process holds the registry; the Redis-backed event/command channels
 * (bus.ts) are what let a companion on a different connection (or, once
 * horizontally scaled, a different process reachable via sticky routing)
 * observe them. Migrating `RelayState` itself to Redis is a known follow-up
 * (see module report) — it does not change any function signature below.
 *
 * OWNER-BINDING (adversarial review P2-1/P2-2, safe default): a session is
 * only reachable — listed, streamed, or commanded — by the SAME userId that
 * registered it. This models "companion = the same person's own mobile",
 * matching the Claude Code mobile-panel pattern this control plane mirrors.
 * A multi-user tenant where teammates may observe/steer each other's
 * sessions is a DELIBERATE future loosening, not this slice's default — see
 * the module report for the founder-decision note.
 */
import { redact, type ControlCommand, type Surface, type SessionRegistration } from "./protocol";

export type SessionStatus = "active" | "ended";

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  /** The user who registered this session — the sole owner (see header). */
  userId: string;
  surface: Surface;
  label?: string;
  cwd?: string;
  status: SessionStatus;
  createdAt: string;
  /** Internal cursors live and are reclaimed with this bounded registry record. */
  sequence: { events: number; commands: number };
}

export interface RelayState {
  sessions: Map<string, SessionRecord>;
  /** Monotonic counter backing the DEFAULT (test-only) mintSessionId. */
  counter: number;
}

/** `seedCounter` lets tests get deterministic, reproducible session ids. */
export function createRelayState(seedCounter = 0): RelayState {
  return { sessions: new Map(), counter: seedCounter };
}

/**
 * DEFAULT session-id generator: a deterministic, in-process counter.
 *
 * ⚠️ TEST/DEV ONLY. This is what P1 of the adversarial review caught: a
 * counter that resets to 0 on every process start reissues the SAME
 * sessionId ("sess_1", "sess_2", …) across restarts. Since the Redis event/
 * command buffers (bus.ts) survive a process restart (TTL 3600s), a reissued
 * id used to let a NEW tenant's fresh session read a PRIOR tenant's stale
 * buffered events under that id — a cross-generation, cross-tenant leak.
 *
 * Production (router.ts) MUST inject a cryptographically random generator
 * via `RegisterSessionOptions.mintId` (e.g. `sess_${crypto.randomUUID()}`)
 * so a collision across process generations is practically impossible. This
 * function stays as the ONLY default so relay.core.ts itself never needs to
 * import `crypto` — keeping the core pure and its tests deterministic — but
 * nothing here relies on Math.random()/Date.now() either.
 *
 * Layer 2 of the P1 fix (defense-in-depth, independent of id randomness) is
 * in bus.ts: buffer/channel keys are namespaced by tenantId, so even a
 * genuine id collision cannot cross a tenant boundary.
 */
export function mintSessionId(state: RelayState): string {
  state.counter += 1;
  return `sess_${state.counter.toString(36)}`;
}

/** Injected in production (router.ts) with a crypto-random generator. */
export type SessionIdGenerator = (state: RelayState) => string;

export interface RegisterSessionOptions {
  /** Injectable clock — defaults to real time (same convention as runEvents.ts's `ts`). */
  now?: () => string;
  /** Injectable id generator — defaults to the deterministic counter (test/dev only, see mintSessionId doc). */
  mintId?: SessionIdGenerator;
  /** Per-tenant active-session ceiling (P2-4 DoS guard). Defaults to DEFAULT_MAX_SESSIONS_PER_TENANT. */
  maxSessionsPerTenant?: number;
}

export type RegisterSessionResult =
  | { ok: true; sessionId: string; record: SessionRecord }
  | { ok: false; reason: "tenant_session_cap_exceeded" };

/**
 * P2-4 DoS guard: an unbounded number of registered sessions per tenant
 * (the registry Map never shrinks on its own) is a memory/resource
 * exhaustion vector. 50 concurrent relay sessions per tenant is generous
 * for the "desktop + a couple of CLI windows, per user, times however many
 * users a workspace has" shape this control plane targets — a real DoS
 * attempt looks nothing like that. Not currently env-configurable (kept as
 * an in-code constant for this slice's minimal footprint); trivial to
 * promote to an env var later if an operator needs to tune it.
 */
export const DEFAULT_MAX_SESSIONS_PER_TENANT = 50;

function allSessionsForTenant(state: RelayState, tenantId: string): SessionRecord[] {
  return Array.from(state.sessions.values()).filter((s) => s.tenantId === tenantId);
}

/** Every session for a tenant, ANY owner — used only for the DoS cap, never exposed to a caller. */
export function countSessionsForTenant(state: RelayState, tenantId: string): number {
  return allSessionsForTenant(state, tenantId).length;
}

/**
 * Frees up to `need` cap slots by evicting the tenant's OLDEST ended
 * sessions first (they're pure history at this point — no live stream, no
 * commands can reach them). Never evicts an active session. Returns the
 * number actually evicted (may be less than `need` if there aren't enough
 * ended sessions to reclaim).
 */
function evictOldestEnded(state: RelayState, tenantId: string, need: number): number {
  const ended = allSessionsForTenant(state, tenantId)
    .filter((s) => s.status === "ended")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sessionId.localeCompare(b.sessionId)));
  let evicted = 0;
  for (const s of ended) {
    if (evicted >= need) break;
    state.sessions.delete(s.sessionId);
    evicted++;
  }
  return evicted;
}

/**
 * Register a new LOCAL session for a tenant/user. Pure aside from mutating
 * the passed-in `state` map/counter. Enforces the per-tenant session cap
 * (P2-4), evicting the oldest ENDED sessions first to make room before ever
 * refusing the register.
 *
 * `label`/`cwd` are redacted here (P3) — once, at write time — so every
 * later read (list, event mirror) is already safe without each call site
 * having to remember to redact.
 */
export function registerSession(
  state: RelayState,
  tenantId: string,
  userId: string,
  reg: SessionRegistration,
  options: RegisterSessionOptions = {},
): RegisterSessionResult {
  const maxPerTenant = options.maxSessionsPerTenant ?? DEFAULT_MAX_SESSIONS_PER_TENANT;
  const current = countSessionsForTenant(state, tenantId);
  if (current >= maxPerTenant) {
    evictOldestEnded(state, tenantId, current - maxPerTenant + 1);
    if (countSessionsForTenant(state, tenantId) >= maxPerTenant) {
      return { ok: false, reason: "tenant_session_cap_exceeded" };
    }
  }

  const now = options.now ?? (() => new Date().toISOString());
  const mintId = options.mintId ?? mintSessionId;
  const sessionId = mintId(state);
  const record: SessionRecord = {
    sessionId,
    tenantId,
    userId,
    surface: reg.surface,
    label: reg.label !== undefined ? redact(reg.label) : undefined,
    cwd: reg.cwd !== undefined ? redact(reg.cwd) : undefined,
    status: "active",
    createdAt: now(),
    sequence: { events: 0, commands: 0 },
  };
  state.sessions.set(sessionId, record);
  return { ok: true, sessionId, record };
}

export function getSession(state: RelayState, sessionId: string): SessionRecord | undefined {
  return state.sessions.get(sessionId);
}

/**
 * LOAD-BEARING SECURITY CHECK. A companion (or a local session posting an
 * event) may only touch a session that belongs to its OWN tenant AND was
 * registered by that SAME user (owner-binding, P2-1/P2-2). Unknown session
 * id, cross-tenant session, and cross-USER-same-tenant session all return
 * false — callers must collapse all three to the same 404/403 response so a
 * probe can't distinguish "doesn't exist" from "exists, belongs to someone
 * else" (P1-shaped leak if it can).
 */
export function canAccessSession(state: RelayState, tenantId: string, userId: string, sessionId: string): boolean {
  const record = state.sessions.get(sessionId);
  if (!record) return false;
  return record.tenantId === tenantId && record.userId === userId;
}

export type AuthorizeCommandResult = { ok: true } | { ok: false; reason: string };

const VALID_COMMAND_KINDS: ReadonlySet<ControlCommand["type"]> = new Set(["steer", "approve", "reject", "kill"]);

/**
 * Gate for companion → local-session commands. Enforces, in order:
 *   1. the session exists
 *   2. it belongs to the caller's tenant AND was registered by the caller's
 *      OWN userId (owner-binding — otherwise ANY teammate in a multi-user
 *      tenant could approve/reject someone else's R6 governance dialog, a
 *      within-tenant privilege escalation over the governance moat)
 *   3. it hasn't ended (a dead session can't be steered/approved/killed again)
 *   4. the command's `type` is one this contract recognizes
 * zod already rejects malformed commands before this is called in the real
 * router, but this stays defensive so calling it directly (as tests do)
 * gives the same answer without relying on that upstream parse.
 */
export function authorizeCommand(
  state: RelayState,
  tenantId: string,
  userId: string,
  sessionId: string,
  cmd: ControlCommand,
): AuthorizeCommandResult {
  const record = state.sessions.get(sessionId);
  if (!record) return { ok: false, reason: "session not found" };
  if (record.tenantId !== tenantId) return { ok: false, reason: "session belongs to a different tenant" };
  if (record.userId !== userId) return { ok: false, reason: "session belongs to a different user" };
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

/**
 * Every session belonging to `tenantId` AND owned by `userId`, oldest
 * first — this is the companion's session picker, so it must show the SAME
 * owner-binding boundary `canAccessSession`/`authorizeCommand` enforce
 * (otherwise a teammate would see a session in the list they then can't
 * open — a metadata leak of another user's activity within the tenant).
 * Loosening this to tenant-wide "team visibility" is the same founder
 * decision noted on canAccessSession, not an accidental gap.
 */
export function listSessions(state: RelayState, tenantId: string, userId: string): SessionRecord[] {
  return Array.from(state.sessions.values())
    .filter((s) => s.tenantId === tenantId && s.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sessionId.localeCompare(b.sessionId)));
}
