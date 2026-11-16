/** BRA-P0-09b — GET /runs/:id/evidence: fixture koşusunda paket, kaynak yok durumu, deterministik özet, sızıntı, tenant, truncated. */
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
import { MAX_PACK_CALLS, MAX_PACK_STEPS } from "../evidence-pack";

const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/evidence" && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

async function call() {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ auth: { tenantId: "t1", userId: "u", role: "admin" }, params: { id: "run-1" }, query: {}, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}

const SECRET = "sk-ant-api03-SUPERSECRETTOKEN";
const SHA = "a".repeat(40);
const PR_URL = "https://github.com/o/r/pull/7";
const DIFF_TEXT = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", "-const old = 1;", `+const key = "${SECRET}";`].join("\n");
const ROW = (over: Record<string, unknown> = {}) => ({
  id: "rc1", runId: "run-1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: 0.25,
  evidence: [{ kind: "diff", ref: "tool_call:c1" }, { kind: "test", ref: "tool_call:c2", ok: true }, { kind: "pr", ref: PR_URL }],
  approvalIds: ["ap1"], contentHash: "hash-1", createdAt: new Date("2026-11-09T10:00:00Z"), ...over,
});
const RUN = (over: Record<string, unknown> = {}) => ({
  id: "run-1", costUsd: 0.3,
  steps: [{ stepIndex: 0, name: "fix", status: "COMPLETED", costUsd: 0.1, startedAt: new Date("2026-11-09T09:00:00Z"), completedAt: null, reasoning: SECRET }],
  approvals: [{ id: "ap1", type: "SPEND", status: "APPROVED", decidedBy: "u1", decidedAt: new Date("2026-11-09T09:30:00Z"), createdAt: new Date("2026-11-09T09:10:00Z"), amountUsd: 1.5, description: SECRET }],
  ...over,
});
const diffCall = { toolName: "git_diff", status: "COMPLETED", input: { token: SECRET }, output: { diff: DIFF_TEXT } };
const testCall = { toolName: "run_tests", status: "COMPLETED", input: {}, output: { exitCode: 0, passed: 7, failed: 0, stdout: `ok ${SECRET}` } };
const commitCall = { id: "c1", toolName: "git_commit", status: "COMPLETED", output: { sha: SHA.toUpperCase(), message: SECRET } };
const prDry = { id: "c3", toolName: "create_pull_request", status: "COMPLETED", output: { dryRun: true, prUrl: null, request: { body: SECRET } } };
const prStatus = { id: "c4", toolName: "get_github_pr_status", status: "COMPLETED", output: { status: "COMPLETED", pr: { url: PR_URL, mergeableState: "clean", headSha: SHA, state: "open" } } };

/** Sorgu iki kez gelir: özet araçları (diff/test) ve paket araçları. Ayrım `OR` adlarından. */
function setup(summaryCalls: unknown[], packCalls: unknown[], run: unknown = RUN(), receipt: unknown = ROW()) {
  runFindFirst.mockResolvedValue(run);
  receiptFindFirst.mockResolvedValue(receipt);
  toolCallFindMany.mockImplementation(async (args: any) => (args.where.OR.some((o: any) => o.toolName.equals === "get_github_pr_status") ? packCalls : summaryCalls));
}
beforeEach(() => { vi.clearAllMocks(); });

describe("GET /runs/:id/evidence", () => {
  it("yabancı kiracı → 404; makbuz ve araç çağrıları sorgulanmaz", async () => {
    runFindFirst.mockResolvedValue(null);
    const { err } = await call();
    expect(err?.statusCode).toBe(404);
    expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t1" } } });
    expect(receiptFindFirst).not.toHaveBeenCalled();
    expect(toolCallFindMany).not.toHaveBeenCalled();
  });
  it("makbuz yok → 404 receipt_not_found", async () => {
    setup([], [], RUN(), null);
    const { res } = await call();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "receipt_not_found" });
  });
  it("kod ajanı fixture koşusu: SHA, PR, CI, diff, test, adım, onay, maliyet; makbuza bağlı", async () => {
    setup([diffCall, testCall], [commitCall, prStatus]);
    const { res } = await call();
    const b = res.body;
    expect(b.runId).toBe("run-1");
    expect(b.receipt).toMatchObject({ id: "rc1", contentHash: "hash-1", resultStatus: "VERIFIED", evidenceCounts: { diff: 1, test: 1, pr: 1 }, approvalIds: ["ap1"] });
    expect(b.cost).toEqual({ receiptUsd: 0.25, runUsd: 0.3 });
    expect(b.code.commits).toEqual({ status: "available", source: "tool_calls:git_commit", value: [{ sha: SHA, ref: "tool_call:c1" }] });
    expect(b.code.pullRequest).toEqual({ status: "available", source: "receipt.evidence:pr", value: { url: PR_URL } });
    expect(b.code.ci).toEqual({ status: "available", source: "tool_call:c4", value: { state: "passing", mergeableState: "clean", headSha: SHA } });
    expect(b.code.diff.value).toMatchObject({ fileCount: 1, additions: 1, deletions: 1, files: [{ path: "src/a.ts" }] });
    expect(b.code.tests.value).toMatchObject({ passed: 7, failed: 0, ok: true });
    expect(b.steps).toEqual([{ stepIndex: 0, name: "fix", status: "COMPLETED", costUsd: 0.1, startedAt: "2026-11-09T09:00:00.000Z", completedAt: null }]);
    expect(b.approvals).toEqual([{ id: "ap1", type: "SPEND", status: "APPROVED", amountUsd: 1.5, decidedBy: "u1", decidedAt: "2026-11-09T09:30:00.000Z", createdAt: "2026-11-09T09:10:00.000Z" }]);
    expect(b.truncated).toBe(false);
    expect(b.packHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("kaynak yokken açık unavailable + neden; uydurma SHA/PR/CI yok", async () => {
    setup([], [], RUN(), ROW({ evidence: [], approvalIds: [] }));
    const { res } = await call();
    for (const k of ["commits", "pullRequest", "ci", "diff", "tests"]) {
      expect(res.body.code[k]).toMatchObject({ status: "unavailable", value: null, source: null });
      expect(typeof res.body.code[k].reason).toBe("string");
    }
  });
  it("PR dry-run (prUrl:null) → unavailable, neden dry-run; CI bağlanamaz; geçersiz SHA reddedilir", async () => {
    setup([], [{ ...commitCall, output: { sha: "not-a-sha" } }, prDry, prStatus], RUN(), ROW({ evidence: [] }));
    const { res } = await call();
    expect(res.body.code.pullRequest.reason).toMatch(/dry-run/);
    expect(res.body.code.ci.status).toBe("unavailable");
    expect(res.body.code.commits.reason).toMatch(/SHA/);
  });
  it("özet deterministik; veri değişince değişir (makbuz hash'i, SHA)", async () => {
    setup([diffCall], [commitCall]);
    const a = (await call()).res.body.packHash;
    const b = (await call()).res.body.packHash;
    expect(a).toBe(b);
    setup([diffCall], [commitCall], RUN(), ROW({ contentHash: "hash-2" }));
    expect((await call()).res.body.packHash).not.toBe(a);
    setup([diffCall], [{ ...commitCall, output: { sha: "b".repeat(40) } }]);
    expect((await call()).res.body.packHash).not.toBe(a);
  });
  it("sır / satır içeriği / ham çıktı / gerekçe / açıklama sızmaz", async () => {
    setup([diffCall, testCall], [commitCall, prDry, prStatus]);
    const s = JSON.stringify((await call()).res.body);
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain("const old");
    expect(s).not.toContain("stdout");
    expect(s).not.toContain("reasoning");
    expect(s).not.toContain("description");
  });
  it("tenant kapsamı: araç çağrısı sorguları kiracı + koşu kapsamlı", async () => {
    setup([], []);
    await call();
    for (const c of toolCallFindMany.mock.calls) {
      expect(c[0].where.runStep).toEqual({ runId: "run-1", run: { pipeline: { company: { tenantId: "t1" } } } });
    }
    expect(receiptFindFirst.mock.calls[0][0].where).toEqual({ runId: "run-1", tenantId: "t1" });
  });
  it("çağrı/adım sınırı aşılınca truncated=true", async () => {
    const many = Array.from({ length: MAX_PACK_CALLS + 1 }, (_, i) => ({ ...commitCall, id: `x${i}`, output: { sha: i.toString(16).padStart(40, "0") } }));
    const steps = Array.from({ length: MAX_PACK_STEPS + 1 }, (_, i) => ({ stepIndex: i, name: `s${i}`, status: "COMPLETED", costUsd: null, startedAt: null, completedAt: null }));
    setup([], many, RUN({ steps }));
    const { res } = await call();
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedParts).toMatchObject({ toolCalls: true, steps: true });
    expect(res.body.steps).toHaveLength(MAX_PACK_STEPS);
  });
});
