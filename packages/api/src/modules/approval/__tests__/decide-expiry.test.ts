/**
 * BRA-P0-05 — POST /approvals/:id/decide refuses an approval past its expiry
 * (the expiry cron may not have flipped it yet) with no state change. Legacy
 * rows with a NULL expiry are unchanged. Handler driven directly; persistence
 * synthetic. RBAC for this route is covered by decision-reason-http.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const findUnique = vi.hoisted(() => vi.fn());
const tenantTxMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: { approval: { findUnique: (...a: unknown[]) => findUnique(...a) } },
  tenantTx: (...a: unknown[]) => tenantTxMock(...a),
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../external/control", () => ({ runControlAction: vi.fn() }));

import { approvalRouter } from "../router";

function decideHandler() {
  const layer = (approvalRouter as Router as any).stack.find(
    (l: any) => l.route?.path === "/:id/decide" && l.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
async function decide(body: unknown = { decision: "APPROVED" }) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await decideHandler()({ auth: { tenantId: "tenant-1", userId: "u-1" }, params: { id: "ap-1" }, body }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

const approval = (patch: Record<string, unknown> = {}) => ({
  id: "ap-1",
  runId: "run-1",
  type: "SPEND",
  status: "PENDING",
  amountUsd: null,
  metadata: {},
  expiresAt: null,
  run: { pipeline: { company: { tenantId: "tenant-1" } } },
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  tenantTxMock.mockResolvedValue({ won: false }); // stop right after the gate: we only assert the gate
});

describe("decide — expiry gate", () => {
  it("expired (past expiresAt, still PENDING) → 409 'Approval expired'; no transaction opened", async () => {
    findUnique.mockResolvedValue(approval({ expiresAt: new Date(Date.now() - 1000) }));
    const { nextErr } = await decide();
    expect(nextErr?.statusCode).toBe(409);
    expect(nextErr?.message).toBe("Approval expired");
    expect(tenantTxMock).not.toHaveBeenCalled();
  });

  it("exactly at the boundary counts as expired", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
      findUnique.mockResolvedValue(approval({ expiresAt: new Date("2026-11-08T12:00:00Z") }));
      const { nextErr } = await decide({ decision: "REJECTED" });
      expect(nextErr?.message).toBe("Approval expired");
      expect(tenantTxMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("not yet expired → proceeds to the transition", async () => {
    findUnique.mockResolvedValue(approval({ expiresAt: new Date(Date.now() + 60_000) }));
    const { nextErr } = await decide();
    expect(tenantTxMock).toHaveBeenCalledOnce();
    expect(nextErr?.message).toBe("Approval was just decided by another admin"); // our stub's lost-race answer
  });

  it("legacy row with NULL expiresAt → unchanged behaviour", async () => {
    findUnique.mockResolvedValue(approval({ expiresAt: null }));
    await decide();
    expect(tenantTxMock).toHaveBeenCalledOnce();
  });

  it("already-decided is still reported first as 409 'already decided'", async () => {
    findUnique.mockResolvedValue(approval({ status: "APPROVED", expiresAt: new Date(Date.now() - 1000) }));
    const { nextErr } = await decide();
    expect(nextErr?.message).toBe("Approval already decided");
  });
});
