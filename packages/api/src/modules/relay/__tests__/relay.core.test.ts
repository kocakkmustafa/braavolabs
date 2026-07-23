/**
 * relay.core — the SAF tenant-isolation state machine. This is the
 * load-bearing security surface for the relay control plane: a
 * companion/command from tenant A must NEVER reach a session owned by
 * tenant B. No Redis/express involved — pure functions over an in-memory
 * RelayState.
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
} from "../relay.core";
import type { ControlCommand } from "../protocol";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

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
  it("binds the session to the registering tenant", () => {
    const state = createRelayState();
    const { sessionId, record } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.status).toBe("active");
    expect(getSession(state, sessionId)).toEqual(record);
  });

  it("accepts an injectable clock for deterministic createdAt in tests", () => {
    const state = createRelayState();
    const { record } = registerSession(state, TENANT_A, { surface: "cli" }, () => "2026-01-01T00:00:00.000Z");
    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves optional label/cwd", () => {
    const state = createRelayState();
    const { record } = registerSession(state, TENANT_A, { surface: "cli", label: "office-mac", cwd: "/repo" });
    expect(record.label).toBe("office-mac");
    expect(record.cwd).toBe("/repo");
  });
});

describe("canAccessSession — CRITICAL cross-tenant isolation", () => {
  it("returns true for the owning tenant", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(canAccessSession(state, TENANT_A, sessionId)).toBe(true);
  });

  it("returns false for a DIFFERENT tenant (P1 if this ever flips)", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(canAccessSession(state, TENANT_B, sessionId)).toBe(false);
  });

  it("returns false for an unknown session id", () => {
    const state = createRelayState();
    expect(canAccessSession(state, TENANT_A, "sess_does_not_exist")).toBe(false);
  });

  it("unknown-session and cross-tenant-session both read as `false` — indistinguishable to the caller", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(canAccessSession(state, TENANT_B, sessionId)).toBe(canAccessSession(state, TENANT_B, "sess_ghost"));
  });
});

describe("authorizeCommand — CRITICAL cross-tenant + lifecycle gating", () => {
  const steer: ControlCommand = { type: "steer", message: "slow down" };
  const approve: ControlCommand = { type: "approve", actionId: "act-1" };

  it("authorizes a command from the owning tenant", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(authorizeCommand(state, TENANT_A, sessionId, steer)).toEqual({ ok: true });
  });

  it("REJECTS a command from a different tenant — cross-tenant companion cannot steer/approve/kill someone else's session", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    const result = authorizeCommand(state, TENANT_B, sessionId, approve);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tenant/i);
  });

  it("rejects a command against an unknown session", () => {
    const state = createRelayState();
    const result = authorizeCommand(state, TENANT_A, "sess_ghost", steer);
    expect(result.ok).toBe(false);
  });

  it("rejects any command once the session has ended", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    endSession(state, sessionId);
    const result = authorizeCommand(state, TENANT_A, sessionId, steer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ended/i);
  });

  it("kill is authorized on an active session (so the caller CAN end it)", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    expect(authorizeCommand(state, TENANT_A, sessionId, { type: "kill" })).toEqual({ ok: true });
  });
});

describe("endSession", () => {
  it("flips status to ended", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    endSession(state, sessionId);
    expect(getSession(state, sessionId)?.status).toBe("ended");
  });

  it("is a no-op (does not throw) for an unknown session id", () => {
    const state = createRelayState();
    expect(() => endSession(state, "sess_ghost")).not.toThrow();
  });
});

describe("listSessions — tenant-scoped listing", () => {
  it("returns only the calling tenant's sessions", () => {
    const state = createRelayState();
    const a1 = registerSession(state, TENANT_A, { surface: "desktop" }).sessionId;
    const a2 = registerSession(state, TENANT_A, { surface: "cli" }).sessionId;
    const b1 = registerSession(state, TENANT_B, { surface: "desktop" }).sessionId;

    const listA = listSessions(state, TENANT_A).map((s) => s.sessionId);
    const listB = listSessions(state, TENANT_B).map((s) => s.sessionId);

    expect(listA.sort()).toEqual([a1, a2].sort());
    expect(listB).toEqual([b1]);
    expect(listA).not.toContain(b1);
  });

  it("returns an empty list for a tenant with no sessions", () => {
    const state = createRelayState();
    registerSession(state, TENANT_A, { surface: "desktop" });
    expect(listSessions(state, "tenant-nobody")).toEqual([]);
  });

  it("includes ended sessions too (history), still tenant-scoped", () => {
    const state = createRelayState();
    const { sessionId } = registerSession(state, TENANT_A, { surface: "desktop" });
    endSession(state, sessionId);
    const list = listSessions(state, TENANT_A);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("ended");
  });
});
