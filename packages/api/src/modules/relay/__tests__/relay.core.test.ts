/**
 * relay.core — the SAF tenant+owner isolation state machine. This is the
 * load-bearing security surface for the relay control plane: a
 * companion/command from tenant A must NEVER reach a session owned by
 * tenant B (P1), and — since the adversarial review's P2 findings — a
 * DIFFERENT USER within the SAME tenant must never reach another user's
 * session either (owner-binding safe default). No Redis/express involved —
 * pure functions over an in-memory RelayState.
 */
import { describe, it, expect } from "vitest";
import {
  createRelayState,
  mintSessionId,
  registerSession,
  getSession,
  canAccessSession,
  authorizeCommand,
  endSession,
  listSessions,
  countSessionsForTenant,
  DEFAULT_MAX_SESSIONS_PER_TENANT,
  type RelayState,
  type RegisterSessionResult,
} from "../relay.core";
import type { ControlCommand, SessionRegistration } from "../protocol";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const USER_A1 = "user-a1";
const USER_A2 = "user-a2"; // a SECOND user in tenant A — the P2 cross-user test subject
const USER_B1 = "user-b1";

/** registerSession now returns a result union — this helper asserts success and unwraps it. */
function mustRegister(
  state: RelayState,
  tenantId: string,
  userId: string,
  reg: SessionRegistration = { surface: "desktop" },
  options?: Parameters<typeof registerSession>[4],
) {
  const result: RegisterSessionResult = registerSession(state, tenantId, userId, reg, options);
  if (!result.ok) throw new Error(`expected registration to succeed, got: ${result.reason}`);
  return result;
}

describe("mintSessionId", () => {
  it("is deterministic given a seeded counter (no Math.random/Date.now dependency)", () => {
    const state1 = createRelayState(0);
    const state2 = createRelayState(0);
    expect(mintSessionId(state1)).toBe(mintSessionId(state2));
  });

  it("never collides within a state (monotonic counter)", () => {
    const state = createRelayState();
    const ids = new Set([mintSessionId(state), mintSessionId(state), mintSessionId(state)]);
    expect(ids.size).toBe(3);
  });
});

describe("registerSession", () => {
  it("binds the session to the registering tenant AND user", () => {
    const state = createRelayState();
    const { sessionId, record } = mustRegister(state, TENANT_A, USER_A1);
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.userId).toBe(USER_A1);
    expect(record.status).toBe("active");
    expect(getSession(state, sessionId)).toEqual(record);
  });

  it("accepts an injectable clock for deterministic createdAt in tests", () => {
    const state = createRelayState();
    const { record } = mustRegister(state, TENANT_A, USER_A1, { surface: "cli" }, { now: () => "2026-01-01T00:00:00.000Z" });
    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts an injectable id generator (production injects a crypto-random one — see router.ts)", () => {
    const state = createRelayState();
    const { record } = mustRegister(state, TENANT_A, USER_A1, { surface: "cli" }, { mintId: () => "sess_fixed-id" });
    expect(record.sessionId).toBe("sess_fixed-id");
  });

  it("preserves optional label/cwd when they contain nothing secret-shaped", () => {
    const state = createRelayState();
    const { record } = mustRegister(state, TENANT_A, USER_A1, { surface: "cli", label: "office-mac", cwd: "/repo" });
    expect(record.label).toBe("office-mac");
    expect(record.cwd).toBe("/repo");
  });

  it("P3: redacts label/cwd if they happen to contain a secret-shaped value", () => {
    const state = createRelayState();
    const { record } = mustRegister(state, TENANT_A, USER_A1, {
      surface: "cli",
      label: "sk-ABCDEFGHIJ1234567890",
      cwd: "/Users/x/Bearer aaaaaaaaaaaaaaaaaaaaaaaa/project",
    });
    expect(record.label).toBe("«redacted»");
    expect(record.cwd).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  describe("P2-4: per-tenant session cap (DoS guard)", () => {
    it("refuses registration once the tenant is at the cap, with a low test cap", () => {
      const state = createRelayState();
      const cap = 3;
      for (let i = 0; i < cap; i++) {
        expect(mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap }).sessionId).toBeTruthy();
      }
      const result = registerSession(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("tenant_session_cap_exceeded");
      expect(countSessionsForTenant(state, TENANT_A)).toBe(cap);
    });

    it("evicts the OLDEST ENDED session first to make room rather than refusing", () => {
      const state = createRelayState();
      const cap = 2;
      const first = mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap, now: () => "2026-01-01T00:00:00.000Z" });
      mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap, now: () => "2026-01-01T00:00:01.000Z" });
      endSession(state, first.sessionId);

      const third = registerSession(state, TENANT_A, USER_A1, { surface: "cli" }, { maxSessionsPerTenant: cap, now: () => "2026-01-01T00:00:02.000Z" });
      expect(third.ok).toBe(true);
      expect(countSessionsForTenant(state, TENANT_A)).toBe(cap);
      expect(getSession(state, first.sessionId)).toBeUndefined(); // evicted
    });

    it("never evicts an ACTIVE session — refuses instead when there's nothing ended to reclaim", () => {
      const state = createRelayState();
      const cap = 2;
      mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap });
      const second = mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap });

      const result = registerSession(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap });
      expect(result.ok).toBe(false);
      // Both original ACTIVE sessions must still be present — untouched.
      expect(getSession(state, second.sessionId)?.status).toBe("active");
      expect(countSessionsForTenant(state, TENANT_A)).toBe(cap);
    });

    it("the cap is PER TENANT — tenant B registering is unaffected by tenant A being at its cap", () => {
      const state = createRelayState();
      const cap = 1;
      mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }, { maxSessionsPerTenant: cap });
      const result = registerSession(state, TENANT_B, USER_B1, { surface: "desktop" }, { maxSessionsPerTenant: cap });
      expect(result.ok).toBe(true);
    });

    it("defaults to DEFAULT_MAX_SESSIONS_PER_TENANT (50) when no override is passed", () => {
      expect(DEFAULT_MAX_SESSIONS_PER_TENANT).toBe(50);
    });
  });
});

describe("canAccessSession — CRITICAL cross-tenant AND cross-user isolation", () => {
  it("returns true for the owning tenant + owning user", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    expect(canAccessSession(state, TENANT_A, USER_A1, sessionId)).toBe(true);
  });

  it("returns false for a DIFFERENT tenant (P1 if this ever flips)", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    expect(canAccessSession(state, TENANT_B, USER_B1, sessionId)).toBe(false);
  });

  it("P2: returns false for a DIFFERENT USER in the SAME tenant — a teammate cannot observe your session", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    expect(canAccessSession(state, TENANT_A, USER_A2, sessionId)).toBe(false);
  });

  it("returns false for an unknown session id", () => {
    const state = createRelayState();
    expect(canAccessSession(state, TENANT_A, USER_A1, "sess_does_not_exist")).toBe(false);
  });

  it("unknown-session, cross-tenant, and cross-user-same-tenant all read as the SAME `false` — indistinguishable to the caller", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    const crossTenant = canAccessSession(state, TENANT_B, USER_B1, sessionId);
    const crossUser = canAccessSession(state, TENANT_A, USER_A2, sessionId);
    const unknown = canAccessSession(state, TENANT_A, USER_A1, "sess_ghost");
    expect(crossTenant).toBe(false);
    expect(crossUser).toBe(false);
    expect(unknown).toBe(false);
  });
});

describe("authorizeCommand — CRITICAL cross-tenant + cross-user + lifecycle gating", () => {
  const steer: ControlCommand = { type: "steer", message: "slow down" };
  const approve: ControlCommand = { type: "approve", actionId: "act-1" };

  it("authorizes a command from the owning tenant + owning user", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    expect(authorizeCommand(state, TENANT_A, USER_A1, sessionId, steer)).toEqual({ ok: true });
  });

  it("REJECTS a command from a different tenant — cross-tenant companion cannot steer/approve/kill someone else's session", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    const result = authorizeCommand(state, TENANT_B, USER_B1, sessionId, approve);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tenant/i);
  });

  it("P2 APPROVE-HIJACK: REJECTS a command from a DIFFERENT USER in the SAME tenant — a teammate cannot approve/reject/kill your governed action", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    const result = authorizeCommand(state, TENANT_A, USER_A2, sessionId, approve);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/user/i);
  });

  it("rejects a command against an unknown session", () => {
    const state = createRelayState();
    const result = authorizeCommand(state, TENANT_A, USER_A1, "sess_ghost", steer);
    expect(result.ok).toBe(false);
  });

  it("rejects any command once the session has ended", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    endSession(state, sessionId);
    const result = authorizeCommand(state, TENANT_A, USER_A1, sessionId, steer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ended/i);
  });

  it("kill is authorized on an active session (so the OWNER can end it)", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    expect(authorizeCommand(state, TENANT_A, USER_A1, sessionId, { type: "kill" })).toEqual({ ok: true });
  });
});

describe("endSession", () => {
  it("flips status to ended", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    endSession(state, sessionId);
    expect(getSession(state, sessionId)?.status).toBe("ended");
  });

  it("is a no-op (does not throw) for an unknown session id", () => {
    const state = createRelayState();
    expect(() => endSession(state, "sess_ghost")).not.toThrow();
  });
});

describe("listSessions — owner-scoped listing (tenant AND user)", () => {
  it("returns only the calling user's own sessions", () => {
    const state = createRelayState();
    const a1 = mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" }).sessionId;
    const a2 = mustRegister(state, TENANT_A, USER_A1, { surface: "cli" }).sessionId;
    const b1 = mustRegister(state, TENANT_B, USER_B1, { surface: "desktop" }).sessionId;

    const listA1 = listSessions(state, TENANT_A, USER_A1).map((s) => s.sessionId);
    const listB1 = listSessions(state, TENANT_B, USER_B1).map((s) => s.sessionId);

    expect(listA1.sort()).toEqual([a1, a2].sort());
    expect(listB1).toEqual([b1]);
    expect(listA1).not.toContain(b1);
  });

  it("P2: does NOT include a teammate's sessions in the SAME tenant", () => {
    const state = createRelayState();
    mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" });
    const a2session = mustRegister(state, TENANT_A, USER_A2, { surface: "cli" }).sessionId;

    const listA1 = listSessions(state, TENANT_A, USER_A1).map((s) => s.sessionId);
    expect(listA1).not.toContain(a2session);

    const listA2 = listSessions(state, TENANT_A, USER_A2).map((s) => s.sessionId);
    expect(listA2).toEqual([a2session]);
  });

  it("returns an empty list for a user with no sessions", () => {
    const state = createRelayState();
    mustRegister(state, TENANT_A, USER_A1, { surface: "desktop" });
    expect(listSessions(state, TENANT_A, "user-nobody")).toEqual([]);
  });

  it("includes ended sessions too (history), still owner-scoped", () => {
    const state = createRelayState();
    const { sessionId } = mustRegister(state, TENANT_A, USER_A1);
    endSession(state, sessionId);
    const list = listSessions(state, TENANT_A, USER_A1);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("ended");
  });
});
