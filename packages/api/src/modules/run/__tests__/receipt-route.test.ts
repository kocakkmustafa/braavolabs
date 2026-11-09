/** BRA-P0-04c — GET /runs/:id/receipt: tenant izolasyonu, 404'ler, yanıt anahtar sözleşmesi. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const runFindFirst = vi.hoisted(() => vi.fn());
const receiptFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { run: { findFirst: (...a: unknown[]) => runFindFirst(...a) }, jobReceipt: { findFirst: (...a: unknown[]) => receiptFindFirst(...a) } },
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../../services/ai-client", async (o) => ({ ...(await o<typeof import("../../../services/ai-client")>()), chatCompletion: vi.fn() }));
vi.mock("../../../services/provider-chain", async (o) => ({ ...(await o<typeof import("../../../services/provider-chain")>()), listTenantProviderLinks: vi.fn().mockResolvedValue([]) }));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../handoff.service", () => ({
  createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" } }));

import { runRouter } from "../router";

const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/receipt" && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

async function call() {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ auth: { tenantId: "t1", userId: "u", role: "admin" }, params: { id: "run-1" }, query: {}, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}

const KEYS = ["approvalIds", "contentHash", "costUsd", "createdAt", "evidence", "id", "outcome", "resultStatus", "runId", "tenantId"];
beforeEach(() => vi.clearAllMocks());

describe("GET /runs/:id/receipt", () => {
  it("başka kiracının koşusu → 404, makbuz sorgulanmaz", async () => {
    runFindFirst.mockResolvedValue(null);
    const { err } = await call();
    expect(err?.statusCode).toBe(404);
    expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t1" } } });
    expect(receiptFindFirst).not.toHaveBeenCalled();
  });
  it("makbuz yok → 404 receipt_not_found", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    receiptFindFirst.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "receipt_not_found" });
    expect(receiptFindFirst.mock.calls[0][0].where).toEqual({ runId: "run-1", tenantId: "t1" });
  });
  it("yanıt anahtar seti kilitli, Decimal sayıya, tarih ISO'ya", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    receiptFindFirst.mockResolvedValue({
      id: "rc1", runId: "run-1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: { toString: () => "0.25", valueOf: () => 0.25 },
      evidence: [{ kind: "diff", ref: "tool_call:c1" }], approvalIds: [], contentHash: "h", createdAt: new Date("2026-11-09T10:00:00Z"), extraSecret: "x",
    });
    const { res } = await call();
    expect(Object.keys(res.body).sort()).toEqual(KEYS);
    expect(res.body.createdAt).toBe("2026-11-09T10:00:00.000Z");
    expect(typeof res.body.costUsd).toBe("number");
  });
});
