/**
 * BRA-P0-05 — exact-action approval primitives (pure + fake-client CAS).
 * No database: `consumeGrant` is driven through a structural fake, so the
 * compare-and-set shape (scalar where, single winner) is asserted directly.
 * NOT covered here (needs real Postgres): the CAS race under two connections.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_HASH_VERSION,
  buildApprovalStamp,
  canonicalize,
  computeActionHash,
  consumeGrant,
  evaluateGrant,
  generateNonce,
  hasOpenApproval,
  isExactActionApprovalEnabled,
  type ExactAction,
  type GrantRow,
} from "../exact-action";

const NOW = new Date("2026-11-08T12:00:00Z");
const base: ExactAction = {
  tenantId: "tenant-1",
  runId: "run-1",
  type: "SPEND",
  toolName: "ad_spend",
  input: { campaign: "c1", budgetUsd: 50, to: ["a@x.io", "b@x.io"] },
  amountUsd: 50,
};

describe("isExactActionApprovalEnabled", () => {
  it.each([undefined, "", "false", "TRUE", "1", "yes"])("%s → off", (v) => {
    expect(isExactActionApprovalEnabled({ EXACT_ACTION_APPROVAL: v } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('only the literal "true" turns it on', () => {
    expect(isExactActionApprovalEnabled({ EXACT_ACTION_APPROVAL: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("canonicalize", () => {
  it("is key-order independent at every depth", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
  it("drops undefined object members like JSON but rejects undefined/NaN/BigInt elsewhere", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(() => canonicalize([undefined])).toThrow();
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize({ a: BigInt(1) })).toThrow();
  });
});

describe("computeActionHash", () => {
  it("is stable and versioned", () => {
    const h = computeActionHash(base);
    expect(h).toBe(computeActionHash({ ...base, input: { to: ["a@x.io", "b@x.io"], budgetUsd: 50, campaign: "c1" } }));
    expect(h.startsWith(`v${ACTION_HASH_VERSION}:`)).toBe(true);
    expect(h).toMatch(/^v1:[0-9a-f]{64}$/);
  });
  it.each([
    ["changed draft/input", { input: { ...(base.input as object), campaign: "c2" } }],
    ["changed recipient list order", { input: { ...(base.input as object), to: ["b@x.io", "a@x.io"] } }],
    ["changed amount", { amountUsd: 51 }],
    ["other tool", { toolName: "send_email" }],
    ["other run", { runId: "run-2" }],
    ["other tenant", { tenantId: "tenant-2" }],
    ["other type", { type: "EXTERNAL_CONTROL" }],
  ] as const)("%s → different hash (old approval cannot authorise it)", (_n, patch) => {
    expect(computeActionHash({ ...base, ...patch } as ExactAction)).not.toBe(computeActionHash(base));
  });
  it("undefined input hashes like null; un-hashable input throws (never silently bound)", () => {
    expect(computeActionHash({ ...base, input: undefined })).toBe(computeActionHash({ ...base, input: null }));
    expect(() => computeActionHash({ ...base, input: { n: BigInt(1) } })).toThrow();
  });
});

describe("buildApprovalStamp / generateNonce", () => {
  it("binds tenant + hash, 24h expiry, fresh nonce each time", () => {
    const a = buildApprovalStamp(base, NOW);
    const b = buildApprovalStamp(base, NOW);
    expect(a.tenantId).toBe("tenant-1");
    expect(a.actionHash).toBe(computeActionHash(base));
    expect(a.expiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce.length).toBeGreaterThanOrEqual(32);
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

const expected = { tenantId: "tenant-1", runId: "run-1", actionHash: computeActionHash(base) };
function row(patch: Partial<GrantRow> = {}): GrantRow {
  return {
    runId: "run-1",
    tenantId: "tenant-1",
    status: "APPROVED",
    nonce: "n-1",
    actionHash: expected.actionHash,
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    ...patch,
  };
}

describe("evaluateGrant (fail-closed)", () => {
  it("accepts a fully bound, approved, unexpired, unconsumed grant", () => {
    expect(evaluateGrant(row(), expected, NOW)).toEqual({ ok: true });
  });
  it.each([
    ["legacy row without nonce", { nonce: null }, "not_exact_action"],
    ["legacy row without hash", { actionHash: null }, "not_exact_action"],
    ["row without tenant", { tenantId: null }, "not_exact_action"],
    ["row without expiry", { expiresAt: null }, "not_exact_action"],
    ["other tenant", { tenantId: "tenant-2" }, "tenant_mismatch"],
    ["other run", { runId: "run-2" }, "run_mismatch"],
    ["still PENDING", { status: "PENDING" }, "not_approved"],
    ["REJECTED", { status: "REJECTED" }, "not_approved"],
    ["EXPIRED", { status: "EXPIRED" }, "not_approved"],
    ["already consumed (replay)", { consumedAt: NOW }, "already_consumed"],
    ["changed draft (hash differs)", { actionHash: "v1:deadbeef" }, "hash_mismatch"],
    ["expired at the boundary", { expiresAt: NOW }, "expired"],
    ["expired in the past", { expiresAt: new Date(NOW.getTime() - 1) }, "expired"],
  ] as const)("%s → %s", (_n, patch, reason) => {
    expect(evaluateGrant(row(patch as Partial<GrantRow>), expected, NOW)).toEqual({ ok: false, reason });
  });
});

function fakeClient(rows: Array<GrantRow & { id: string }>, claimCount = 1) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const updateMany = vi.fn().mockResolvedValue({ count: claimCount });
  return { client: { approval: { findMany, updateMany } }, findMany, updateMany };
}

describe("consumeGrant", () => {
  it("scopes the read by tenant + run + hash + APPROVED + unconsumed, then claims with a scalar CAS", async () => {
    const { client, findMany, updateMany } = fakeClient([{ id: "ap-1", ...row() }]);
    const res = await consumeGrant(client, expected, NOW);
    expect(res).toEqual({ ok: true, approvalId: "ap-1" });
    expect(findMany.mock.calls[0][0].where).toEqual({
      runId: "run-1",
      tenantId: "tenant-1",
      actionHash: expected.actionHash,
      status: "APPROVED",
      consumedAt: null,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "ap-1", nonce: "n-1", status: "APPROVED", consumedAt: null },
      data: { consumedAt: NOW },
    });
    // Scalar-only: no relation filter that Prisma could run as select-then-update.
    expect(Object.keys(updateMany.mock.calls[0][0].where).sort()).toEqual(["consumedAt", "id", "nonce", "status"]);
  });

  it("lost CAS (count 0) → not consumed, side effect must not run", async () => {
    const { client } = fakeClient([{ id: "ap-1", ...row() }], 0);
    expect(await consumeGrant(client, expected, NOW)).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("two grants, first lost the race → the second one is tried", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "ap-1", ...row({ nonce: "n-1" }) },
      { id: "ap-2", ...row({ nonce: "n-2" }) },
    ]);
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const res = await consumeGrant({ approval: { findMany, updateMany } }, expected, NOW);
    expect(res).toEqual({ ok: true, approvalId: "ap-2" });
  });

  it("no candidate → no_grant, nothing written", async () => {
    const { client, updateMany } = fakeClient([]);
    expect(await consumeGrant(client, expected, NOW)).toEqual({ ok: false, reason: "no_grant" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a row the DB returned but that fails the re-check (expired / other hash) is never claimed", async () => {
    const { client, updateMany } = fakeClient([
      { id: "ap-1", ...row({ expiresAt: new Date(NOW.getTime() - 1) }) },
      { id: "ap-2", ...row({ actionHash: "v1:other" }) },
      { id: "ap-3", ...row({ nonce: null }) },
    ]);
    const res = await consumeGrant(client, expected, NOW);
    expect(res.ok).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("hasOpenApproval", () => {
  it("true when a PENDING approval exists, false otherwise (query is by run + PENDING)", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "ap-1" }).mockResolvedValueOnce(null);
    expect(await hasOpenApproval({ approval: { findFirst } }, "run-1")).toBe(true);
    expect(await hasOpenApproval({ approval: { findFirst } }, "run-1")).toBe(false);
    expect(findFirst).toHaveBeenCalledWith({ where: { runId: "run-1", status: "PENDING" }, select: { id: true } });
  });
});
