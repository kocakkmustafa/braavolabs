/** BRA-P0-04c — GET /runs/:id/receipt: tenant izolasyonu, 404'ler, yanıt anahtar sözleşmesi. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const runFindFirst = vi.hoisted(() => vi.fn());
const receiptFindFirst = vi.hoisted(() => vi.fn());
const toolCallFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { run: { findFirst: (...a: unknown[]) => runFindFirst(...a) }, jobReceipt: { findFirst: (...a: unknown[]) => receiptFindFirst(...a) }, toolCall: { findMany: (...a: unknown[]) => toolCallFindMany(...a) } },
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
import { MAX_SUMMARY_CALLS, MAX_SUMMARY_FILES } from "../code-summary";

const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/receipt" && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

async function call() {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ auth: { tenantId: "t1", userId: "u", role: "admin" }, params: { id: "run-1" }, query: {}, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}

const OLD_KEYS = ["approvalIds", "contentHash", "costUsd", "createdAt", "evidence", "id", "outcome", "resultStatus", "runId", "tenantId"];
const KEYS = [...OLD_KEYS, "diffSummary", "testSummary"].sort();
beforeEach(() => { vi.clearAllMocks(); toolCallFindMany.mockResolvedValue([]); });

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
    expect(receiptFindFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" }); // en son makbuz (retry sonrası)
  });
  it("yanıt anahtar seti kilitli, Decimal sayıya, tarih ISO'ya", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    receiptFindFirst.mockResolvedValue({
      id: "rc1", runId: "run-1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: { toString: () => "0.25", valueOf: () => 0.25 },
      evidence: [{ kind: "diff", ref: "tool_call:c1" }], approvalIds: [], contentHash: "h", createdAt: new Date("2026-11-09T10:00:00Z"), extraSecret: "x",
    });
    const { res } = await call();
    expect(Object.keys(res.body).sort()).toEqual(KEYS);
    expect(Object.keys(res.body).filter((k) => OLD_KEYS.includes(k)).sort()).toEqual(OLD_KEYS);
    expect(res.body.testSummary).toBeNull();
    expect(res.body.diffSummary).toBeNull();
    expect(res.body.createdAt).toBe("2026-11-09T10:00:00.000Z");
    expect(typeof res.body.costUsd).toBe("number");
  });
});

describe("GET /runs/:id/receipt — BRA-P1-03-N3 testSummary/diffSummary", () => {
  const ROW = {
    id: "rc1", runId: "run-1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: null,
    evidence: [{ kind: "diff", ref: "tool_call:c1" }], approvalIds: [], contentHash: "h", createdAt: new Date("2026-11-09T10:00:00Z"),
  };
  const SECRET = "sk-ant-api03-SUPERSECRETTOKEN";
  const DIFF_TEXT = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@",
    "-const old = 1;", `+const key = "${SECRET}";`, "+const more = 2;",
  ].join("\n");
  const setup = (calls: unknown[]) => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    receiptFindFirst.mockResolvedValue(ROW);
    toolCallFindMany.mockResolvedValue(calls);
  };

  it("kaynak veri varken doğru toplama; eski alanlar aynı", async () => {
    setup([
      { toolName: "git_diff", status: "COMPLETED", input: {}, output: { diff: DIFF_TEXT } },
      { toolName: "run_tests", status: "COMPLETED", input: {}, output: { exitCode: 0, passed: 7, failed: 0, skipped: 2 } },
    ]);
    const { res } = await call();
    expect(res.body.diffSummary).toMatchObject({
      fileCount: 1, additions: 2, deletions: 1, complete: true, truncated: false,
      files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    });
    expect(res.body.testSummary).toMatchObject({ passed: 7, failed: 0, skipped: 2, total: 9, ok: true, runs: 1 });
    expect(res.body).toMatchObject({ id: "rc1", runId: "run-1", resultStatus: "VERIFIED", evidence: ROW.evidence, contentHash: "h" });
  });
  it("veri yokken ikisi de null", async () => {
    setup([]);
    const { res } = await call();
    expect(res.body.diffSummary).toBeNull();
    expect(res.body.testSummary).toBeNull();
  });
  it("satır içeriği / sır / komut çıktısı yanıta sızmaz", async () => {
    setup([
      { toolName: "git_diff", status: "COMPLETED", input: { token: SECRET }, output: { diff: DIFF_TEXT } },
      { toolName: "run_tests", status: "COMPLETED", input: {}, output: { exitCode: 1, stdout: `FAIL ${SECRET} const old = 1;`, failed: 1 } },
    ]);
    const { res } = await call();
    const s = JSON.stringify(res.body);
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain("const old");
    expect(s).not.toContain("const more");
    expect(s).not.toContain("stdout");
    expect(res.body.testSummary.ok).toBe(false);
  });
  it("yol listesi kırpılınca truncated=true ve liste üst sınırlı", async () => {
    const many = Array.from({ length: MAX_SUMMARY_FILES + 25 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
    setup([{ toolName: "git_diff", status: "COMPLETED", input: {}, output: { files: many } }]);
    const { res } = await call();
    expect(res.body.diffSummary.files.length).toBeLessThanOrEqual(MAX_SUMMARY_FILES);
    expect(res.body.diffSummary.fileCount).toBeGreaterThan(res.body.diffSummary.files.length);
    expect(res.body.diffSummary.truncated).toBe(true);
  });
  it("araç çağrısı sorgu sınırı aşılınca truncated=true", async () => {
    const one = { toolName: "git_diff", status: "COMPLETED", input: {}, output: { files: [{ path: "a.ts", additions: 1, deletions: 0 }] } };
    setup(Array.from({ length: MAX_SUMMARY_CALLS + 1 }, () => one));
    const { res } = await call();
    expect(res.body.diffSummary.truncated).toBe(true);
  });
  it("tenant izolasyonu: araç çağrısı sorgusu kiracı + koşu kapsamlı", async () => {
    setup([]);
    await call();
    expect(toolCallFindMany.mock.calls[0][0].where.runStep).toEqual({ runId: "run-1", run: { pipeline: { company: { tenantId: "t1" } } } });
  });
  it("başka kiracının koşusunda araç çağrıları hiç sorgulanmaz", async () => {
    runFindFirst.mockResolvedValue(null);
    await call();
    expect(toolCallFindMany).not.toHaveBeenCalled();
  });
});
