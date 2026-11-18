/**
 * BRA-P1-08-N3 — onay kararı (decide) HTTP sözleşmesi: web ve mobil aynı uçtan aynı kodu görür.
 *  - başka kiracının onayı → 404 (varlık sızmaz), geçirilemez, işlem açılmaz
 *  - PENDING dışı her durum (APPROVED / REJECTED / EXPIRED) → 409 "already decided", işlem açılmaz
 *  - geçersiz karar gövdesi → hata, işlem açılmaz
 *  - onay durumu enum'u Prisma ile birebir (istemcilerin okuduğu değerler kilitli)
 * Geçerli durumdan beklenen yeni durum: approval-transitions.test.ts (zaten kilitli, burada tekrarlanmaz).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { ApprovalStatus } from "@prisma/client";

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
async function decide(body: unknown, tenantId = "tenant-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await decideHandler()({ auth: { tenantId, userId: "u-1" }, params: { id: "ap-1" }, body }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

const approval = (patch: Record<string, unknown> = {}) => ({
  id: "ap-1", runId: "run-1", type: "SPEND", status: "PENDING", amountUsd: null, metadata: {}, expiresAt: null,
  run: { pipeline: { company: { tenantId: "tenant-1" } } },
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  tenantTxMock.mockResolvedValue({ won: false });
});

describe("approval decide — durum sözleşmesi (BRA-P1-08-N3)", () => {
  it("ApprovalStatus enum değerleri istemcilerin okuduğu kümeyle birebir", () => {
    expect(Object.values(ApprovalStatus).sort()).toEqual(["APPROVED", "EXPIRED", "PENDING", "REJECTED"]);
  });

  it.each(["APPROVED", "REJECTED"])("başka kiracının onayı (%s) → 404, işlem açılmaz", async (decision) => {
    findUnique.mockResolvedValue(approval());
    const { nextErr, res } = await decide({ decision }, "tenant-2");
    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toBe("Approval not found");
    expect(res.body).toBeUndefined();
    expect(tenantTxMock).not.toHaveBeenCalled();
  });

  it("olmayan onay → 404 (başka kiracıyla aynı yanıt: varlık sızmaz)", async () => {
    findUnique.mockResolvedValue(null);
    const { nextErr } = await decide({ decision: "APPROVED" });
    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toBe("Approval not found");
  });

  it.each(["APPROVED", "REJECTED", "EXPIRED"])("durum %s olan onaya karar → 409, işlem açılmaz", async (status) => {
    for (const decision of ["APPROVED", "REJECTED"]) {
      findUnique.mockResolvedValue(approval({ status }));
      const { nextErr } = await decide({ decision });
      expect(nextErr?.statusCode).toBe(409);
      expect(nextErr?.message).toBe("Approval already decided");
    }
    expect(tenantTxMock).not.toHaveBeenCalled();
  });

  it.each([{}, { decision: "MAYBE" }, { decision: "EXPIRED" }, { decision: "PENDING" }, { decision: 1 }])(
    "geçersiz karar gövdesi %j → hata, onay okunmaz, işlem açılmaz",
    async (body) => {
      const { nextErr } = await decide(body);
      expect(nextErr).toBeDefined();
      expect(findUnique).not.toHaveBeenCalled();
      expect(tenantTxMock).not.toHaveBeenCalled();
    },
  );
});
