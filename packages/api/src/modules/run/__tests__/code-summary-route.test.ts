/** BRA-UX-API-06 — GET /runs/:id/code-summary: kiracı kapsamı, 404, sorgu biçimi, yanıt sözleşmesi. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const runFindFirst = vi.hoisted(() => vi.fn());
const toolCallFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { run: { findFirst: (...a: unknown[]) => runFindFirst(...a) }, toolCall: { findMany: (...a: unknown[]) => toolCallFindMany(...a) } },
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
import { EVIDENCE_TOOL_NAMES } from "../receipt";
import { CODE_SUMMARY_TOOL_NAMES, MAX_SUMMARY_CALLS } from "../code-summary";

const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/code-summary" && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

async function call() {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ auth: { tenantId: "t1", userId: "u", role: "admin" }, params: { id: "run-1" }, query: {}, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /runs/:id/code-summary", () => {
  it("rota yalnız GET olarak kayıtlı (yazma yok)", () => {
    expect(layer.route.methods).toEqual({ get: true });
    const same = (runRouter as Router as any).stack.filter((l: any) => l.route?.path === "/:id/code-summary");
    expect(same).toHaveLength(1);
  });
  it("başka kiracının koşusu → 404, araç çağrıları sorgulanmaz", async () => {
    runFindFirst.mockResolvedValue(null);
    const { err } = await call();
    expect(err?.statusCode).toBe(404);
    expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t1" } } });
    expect(toolCallFindMany).not.toHaveBeenCalled();
  });
  it("araç çağrısı sorgusu kiracı + koşu kapsamlı, yalnız izinli araçlar, sıralı ve sınırlı", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    toolCallFindMany.mockResolvedValue([]);
    await call();
    const q = toolCallFindMany.mock.calls[0][0];
    expect(q.where.runStep).toEqual({ runId: "run-1", run: { pipeline: { company: { tenantId: "t1" } } } });
    // yalnız diff + test araçları (PR aracı kotayı yemez)
    expect(q.where.OR.map((x: any) => x.toolName.equals)).toEqual(CODE_SUMMARY_TOOL_NAMES);
    expect(q.where.OR.map((x: any) => x.toolName.equals)).not.toContain("create_pull_request");
    expect(q.where.OR[0].toolName.mode).toBe("insensitive");
    expect(CODE_SUMMARY_TOOL_NAMES.length).toBeLessThan(EVIDENCE_TOOL_NAMES.length);
    // en yeni çağrılar (desc), sınır + 1 satır (kesilme tespiti)
    expect(q.orderBy).toEqual([{ runStep: { stepIndex: "desc" } }, { createdAt: "desc" }, { id: "desc" }]);
    expect(q.take).toBe(MAX_SUMMARY_CALLS + 1);
    expect(Object.keys(q.select).sort()).toEqual(["input", "output", "status", "toolName"]);
  });
  it("kod aracı yok → 200, diff ve tests null", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    toolCallFindMany.mockResolvedValue([]);
    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ runId: "run-1", diff: null, tests: null });
    expect(typeof res.body.generatedAt).toBe("string");
  });
  it("satırlar en yeniden eskiye gelir: ters çevrilip kronolojik işlenir (son test çağrısı kazanır)", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    toolCallFindMany.mockResolvedValue([
      { toolName: "run_tests", status: "COMPLETED", input: {}, output: { passed: 9, exitCode: 0 } }, // en yeni
      { toolName: "run_tests", status: "COMPLETED", input: {}, output: { passed: 1, failed: 3, exitCode: 1 } }, // eski
    ]);
    const { res } = await call();
    // sayılar SON çağrıdan; `ok` makbuz gibi fail-closed: eski kaldı çağrısı da veto eder
    expect(res.body.tests).toMatchObject({ passed: 9, failed: 0, ok: false, runs: 2 });
  });
  it("sınır aşılırsa (MAX+1 satır) en eski atılır ve diff complete=false", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    const rows = Array.from({ length: MAX_SUMMARY_CALLS + 1 }, (_, i) => ({
      toolName: "git_diff", status: "COMPLETED", input: {}, output: { files: [{ path: `f${i}.ts`, additions: 1, deletions: 0 }] },
    }));
    toolCallFindMany.mockResolvedValue(rows);
    const { res } = await call();
    expect(res.body.diff.fileCount).toBe(MAX_SUMMARY_CALLS); // en eski satır (sonuncu) atıldı
    expect(res.body.diff.complete).toBe(false);
  });
  it("diff + test özeti döner; ham çıktı ve girdi dönmez", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    toolCallFindMany.mockResolvedValue([
      { toolName: "git_diff", status: "COMPLETED", input: { secret: "s3cr3t" }, output: { files: [{ path: "src/auth.ts", additions: 12, deletions: 4 }], raw: "GIZLI-GOVDE" } },
      { toolName: "run_tests", status: "COMPLETED", input: {}, output: { passed: 41, failed: 0, exitCode: 0, stdout: "GIZLI-CIKTI" } },
    ]);
    const { res } = await call();
    expect(Object.keys(res.body).sort()).toEqual(["diff", "generatedAt", "runId", "tests"]);
    expect(res.body.diff).toEqual({ files: [{ path: "src/auth.ts", additions: 12, deletions: 4 }], fileCount: 1, additions: 12, deletions: 4, complete: true });
    expect(res.body.tests).toEqual({ passed: 41, failed: 0, skipped: null, total: 41, ok: true, runs: 1 });
    const json = JSON.stringify(res.body);
    for (const leak of ["GIZLI-GOVDE", "GIZLI-CIKTI", "s3cr3t"]) expect(json).not.toContain(leak);
  });
});
