/**
 * BRA-P0-07 — replay (negative, fail-closed).
 * A stateful in-memory approvals table behind the REAL consumeGrant: an
 * approval authorises ONE concrete action once. Complements consume-grant.db
 * (real Postgres races) and exact-action(-gate).test (mocked CAS).
 */
import { describe, expect, it } from "vitest";
import { computeActionHash, consumeGrant, buildApprovalStamp, type ExactAction, type GrantClient } from "../../modules/approval/exact-action";

type Row = { id: string; runId: string; tenantId: string | null; status: string; nonce: string | null; actionHash: string | null; expiresAt: Date | null; consumedAt: Date | null; decidedAt: Date };

function table(rows: Row[]): GrantClient {
  return {
    approval: {
      findMany: async ({ where, take }: any) =>
        rows.filter((r) => r.runId === where.runId && r.tenantId === where.tenantId && r.actionHash === where.actionHash && r.status === where.status && r.consumedAt === null).slice(0, take),
      updateMany: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id && x.nonce === where.nonce && x.status === where.status && x.consumedAt === where.consumedAt);
        if (!r) return { count: 0 };
        Object.assign(r, data); return { count: 1 };
      },
    },
  };
}

const action = (over: Partial<ExactAction> = {}): ExactAction => ({ tenantId: "t1", runId: "run-1", type: "SPEND", toolName: "ad_spend", input: { budgetUsd: 50 }, amountUsd: 50, ...over });
const exp = (a: ExactAction) => ({ tenantId: a.tenantId, runId: a.runId, actionHash: computeActionHash(a) });
function granted(a: ExactAction, over: Partial<Row> = {}): Row {
  const s = buildApprovalStamp(a);
  return { id: "ap-1", runId: a.runId, status: "APPROVED", decidedAt: new Date(), consumedAt: null, tenantId: s.tenantId, nonce: s.nonce, actionHash: s.actionHash, expiresAt: s.expiresAt, ...over };
}

describe("replay of an approval grant", () => {
  it("the same approval spends exactly once; every later attempt is already_consumed/no_grant", async () => {
    const a = action();
    const t = table([granted(a)]);
    expect(await consumeGrant(t, exp(a))).toEqual({ ok: true, approvalId: "ap-1" });
    for (let i = 0; i < 3; i++) {
      const again = await consumeGrant(t, exp(a));
      expect(again.ok).toBe(false);
    }
  });

  it("one approval cannot be replayed with a bigger amount or tweaked input (different hash)", async () => {
    const a = action();
    const t = table([granted(a)]);
    expect((await consumeGrant(t, exp(action({ amountUsd: 5000, input: { budgetUsd: 5000 } })))).ok).toBe(false);
    expect((await consumeGrant(t, exp(action({ toolName: "send_email" })))).ok).toBe(false);
    expect((await consumeGrant(t, exp(a))).ok).toBe(true); // the genuine action is untouched by the failed probes
  });

  it("an approval cannot be replayed in another run or by another tenant", async () => {
    const a = action();
    const t = table([granted(a)]);
    expect((await consumeGrant(t, exp(action({ runId: "run-2" })))).ok).toBe(false);
    expect((await consumeGrant(t, exp(action({ tenantId: "t2" })))).ok).toBe(false);
  });

  it("an expired grant is never spent, and a PENDING/REJECTED one never is either", async () => {
    const a = action();
    const past = new Date(Date.now() - 1000);
    expect(await consumeGrant(table([granted(a, { expiresAt: past })]), exp(a))).toMatchObject({ ok: false, reason: "expired" });
    expect((await consumeGrant(table([granted(a, { status: "PENDING" })]), exp(a))).ok).toBe(false);
    expect((await consumeGrant(table([granted(a, { status: "REJECTED" })]), exp(a))).ok).toBe(false);
  });

  it("a reused nonce on a forged row (no matching stamp) is refused", async () => {
    const a = action();
    const forged = granted(a, { nonce: null });
    expect(await consumeGrant(table([forged]), exp(a))).toMatchObject({ ok: false, reason: "not_exact_action" });
  });

  it("two approvals for one action are two single-use grants, not unlimited", async () => {
    const a = action();
    const t = table([granted(a, { id: "ap-1" }), granted(a, { id: "ap-2" })]);
    const results = [await consumeGrant(t, exp(a)), await consumeGrant(t, exp(a)), await consumeGrant(t, exp(a))];
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });
});
