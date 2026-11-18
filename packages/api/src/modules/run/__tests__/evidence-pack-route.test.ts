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
    expect(b.code.ci).toEqual({ status: "available", source: "tool_call:c4", value: { mergeStateProxy: "mergeable_clean", mergeableState: "clean", headSha: SHA, note: expect.stringContaining("gerçek check-run") } });
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

const statusOf = (over: Record<string, unknown>, id = "c4") => ({ ...prStatus, id, output: { status: "COMPLETED", pr: { ...prStatus.output.pr, ...over } } });
const pack = async () => (await call()).res.body;

describe("evidence — CI vekili", () => {
  it("passing/failing kelimesi yok; unstable → mergeable_unstable; has_hooks/haritada yok → unknown", async () => {
    setup([], [commitCall, statusOf({ mergeableState: "unstable" })]);
    expect((await pack()).code.ci.value).toMatchObject({ mergeStateProxy: "mergeable_unstable" });
    for (const ms of ["has_hooks", "weird_new_state"]) {
      setup([], [commitCall, statusOf({ mergeableState: ms })]);
      const b = await pack();
      expect(b.code.ci.value).toMatchObject({ mergeStateProxy: "unknown", mergeableState: "unknown" });
      expect(JSON.stringify(b.code.ci)).not.toMatch(/passing|failing/);
    }
  });
  it("başka PR URL'si / PR open değil / headSha eşleşmiyor ya da yok → unavailable", async () => {
    for (const over of [{ url: "https://github.com/o/r/pull/99" }, { state: "closed" }, { headSha: "b".repeat(40) }, { headSha: undefined }]) {
      setup([], [commitCall, statusOf(over)]);
      expect((await pack()).code.ci).toMatchObject({ status: "unavailable", value: null });
    }
  });
  it("en yeni durum çağrısı uyuşmuyorsa eski eşleşen çağrıya DÜŞÜLMEZ", async () => {
    // Sorgu en yeniden eskiye gelir (route ters çevirir): ilk eleman EN YENİ.
    setup([], [commitCall, statusOf({ state: "closed" }, "new"), statusOf({}, "old")]);
    expect((await pack()).code.ci.status).toBe("unavailable");
  });
  it("commit yokken CI unavailable (headSha bağlanamaz)", async () => {
    setup([], [statusOf({})]);
    expect((await pack()).code.ci.status).toBe("unavailable");
  });
});

describe("evidence — SHA kaynağı", () => {
  const sha = async (output: unknown, status = "COMPLETED") => {
    setup([], [{ id: "g", toolName: "git_commit", status, output }]);
    return (await pack()).code.commits;
  };
  it.each([["6 hex", "abcdef"], ["41 hex", "a".repeat(41)], ["metin eki", "abcdef1; x"], ["hex değil", "zzzzzzzz"]])("geçersiz SHA reddedilir: %s", async (_n, v) => {
    expect((await sha({ sha: v })).status).toBe("unavailable");
  });
  it("7 ve 40 hex kabul; büyük harf küçültülür; `hash` anahtarı yok sayılır", async () => {
    expect((await sha({ sha: "ABCDEF1" })).value).toEqual([{ sha: "abcdef1", ref: "tool_call:g" }]);
    expect((await sha({ commit: { sha: SHA } })).value[0].sha).toBe(SHA);
    expect((await sha({ commit_sha: SHA })).status).toBe("available");
    expect((await sha({ hash: SHA })).status).toBe("unavailable");
  });
  it("status:FAILED / error işaretli ya da FAILED durumlu git_commit dışlanır", async () => {
    expect((await sha({ status: "FAILED", sha: SHA })).status).toBe("unavailable");
    expect((await sha({ error: "boom", sha: SHA })).status).toBe("unavailable");
    expect((await sha({ sha: SHA }, "FAILED")).status).toBe("unavailable");
  });
  it(">50 commit: ilk 50, truncatedParts.commits", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, toolName: "git_commit", status: "COMPLETED", output: { sha: i.toString(16).padStart(40, "0") } }));
    setup([], many);
    const b = await pack();
    expect(b.code.commits.value).toHaveLength(50);
    expect(b.truncatedParts.commits).toBe(true);
    expect(b.truncated).toBe(true);
  });
});

describe("evidence — packHash her alan için duyarlı", () => {
  it("adım / onay / maliyet / kırpma değişince değişir", async () => {
    setup([], [commitCall]);
    const base = (await pack()).packHash;
    const variants: Array<[string, unknown]> = [
      ["adım", RUN({ steps: [{ ...RUN().steps[0], name: "other" }] })],
      ["onay", RUN({ approvals: [{ ...RUN().approvals[0], status: "REJECTED" }] })],
      ["run maliyeti", RUN({ costUsd: 9 })],
    ];
    for (const [n, run] of variants) {
      setup([], [commitCall], run);
      expect((await pack()).packHash, n).not.toBe(base);
    }
    setup([], [commitCall], RUN(), ROW({ costUsd: 5 }));
    expect((await pack()).packHash).not.toBe(base);
    setup([], Array.from({ length: MAX_PACK_CALLS + 1 }, () => commitCall));
    expect((await pack()).packHash).not.toBe(base);
  });
});

describe("evidence — packHash alan alan duyarlılık (2. tur)", () => {
  const at = (iso: string) => ({ createdAt: new Date(iso) });
  const st = (over: Record<string, unknown> = {}, when = "2026-11-09T09:40:00Z") => ({ ...statusOf(over), ...at(when) });
  const hashOf = async (o: { summary?: unknown[]; calls?: unknown[]; run?: unknown; receipt?: unknown } = {}) => {
    setup(o.summary ?? [diffCall, testCall], o.calls ?? [commitCall, st()], o.run ?? RUN(), o.receipt ?? ROW());
    return (await pack()).packHash;
  };
  it("her alan değişince packHash değişir; değişmeyen girdide aynı", async () => {
    const base = await hashOf();
    expect(await hashOf()).toBe(base);
    const variants: Array<[string, Parameters<typeof hashOf>[0]]> = [
      ["ci.mergeableState", { calls: [commitCall, st({ mergeableState: "unstable" })] }],
      ["ci.observedAt", { calls: [commitCall, st({}, "2026-11-09T09:41:00Z")] }],
      ["pullRequest", { receipt: ROW({ evidence: [{ kind: "diff", ref: "tool_call:c1" }, { kind: "test", ref: "tool_call:c2", ok: true }, { kind: "pr", ref: "https://github.com/o/r/pull/8" }] }) }],
      ["diff", { summary: [{ ...diffCall, output: { diff: DIFF_TEXT.replaceAll("src/a.ts", "src/b.ts") } }, testCall] }],
      ["tests", { summary: [diffCall, { ...testCall, output: { exitCode: 0, passed: 8, failed: 0 } }] }],
      ["evidenceCounts", { receipt: ROW({ evidence: [...ROW().evidence, { kind: "log", ref: "x" }] }) }],
      ["approvalIds", { receipt: ROW({ approvalIds: ["ap1", "ap2"] }) }],
      ["resultStatus", { receipt: ROW({ resultStatus: "UNVERIFIED" }) }],
      ["decidedBy", { run: RUN({ approvals: [{ ...RUN().approvals[0], decidedBy: "u2" }] }) }],
      ["toolCallSummary", { summary: Array.from({ length: 201 }, () => diffCall) }],
    ];
    const seen = new Set([base]);
    for (const [name, v] of variants) {
      const h = await hashOf(v);
      expect(h, name).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(variants.length + 1);
  });
  it("observedAt = durum çağrısının createdAt'i (ISO); yoksa alan yok", async () => {
    setup([], [commitCall, st()]);
    expect((await pack()).code.ci.value.observedAt).toBe("2026-11-09T09:40:00.000Z");
    setup([], [commitCall, statusOf({})]);
    expect("observedAt" in (await pack()).code.ci.value).toBe(false);
  });
  it("headSha yalnız TAM eşitlik: paketteki SHA'nın öneki eşleşmez", async () => {
    setup([], [commitCall, st({ headSha: SHA.slice(0, 7) })]);
    expect((await pack()).code.ci.status).toBe("unavailable");
  });
});

describe("evidence — özet sorgusu kırpıldı", () => {
  it("summaryCalls kırpılınca truncated/toolCallSummary true; tests unavailable(truncated)", async () => {
    const one = { toolName: "git_diff", status: "COMPLETED", input: {}, output: { files: [{ path: "a.ts", additions: 1, deletions: 0 }] } };
    setup(Array.from({ length: 201 }, () => one), []);
    const b = await pack();
    expect(b.truncated).toBe(true);
    expect(b.truncatedParts.toolCallSummary).toBe(true);
    expect(b.code.tests).toMatchObject({ status: "unavailable", value: null });
    expect(b.code.tests.reason).toMatch(/truncated/);
  });
  it("PR değeri kanonik URL", async () => {
    setup([], [], RUN(), ROW({ evidence: [{ kind: "pr", ref: PR_URL }] }));
    expect((await pack()).code.pullRequest.value).toEqual({ url: PR_URL });
  });
});
