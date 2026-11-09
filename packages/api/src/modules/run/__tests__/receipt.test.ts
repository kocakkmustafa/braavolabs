/**
 * BRA-P0-04c — buildReceipt (saf) + terminal geçişte makbuz yazımı (sahte istemci, DB yok).
 * Gerçek Postgres davranışı (RLS, append-only) bu dosyada KANITLANMAZ.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildReceipt, type ReceiptRunInput, type ReceiptToolCall } from "../receipt";
import { transitionRun, type RunTransitionClient } from "../transition";

const tc = (id: string, toolName: string, status = "COMPLETED", output: unknown = {}): ReceiptToolCall => ({ id, toolName, status, output });
const run = (outcome: ReceiptRunInput["outcome"], calls: ReceiptToolCall[], input: unknown = {}): ReceiptRunInput => ({
  id: "run_1", tenantId: "t1", outcome, costUsd: "0.5", input, steps: [{ toolCalls: calls }], approvals: [{ id: "ap_b" }, { id: "ap_a" }],
});
const PR = tc("c3", "github_create_pull_request", "COMPLETED", { html_url: "https://github.com/o/r/pull/7?token=SECRET#x" });
const DIFF = tc("c1", "git_commit");
const TEST_OK = tc("c2", "run_tests", "COMPLETED", { exitCode: 0, stdout: "SECRET RAW OUTPUT" });

describe("buildReceipt", () => {
  it("kod işi: diff+test+PR hepsi var → VERIFIED", () => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, PR], { goal: "Bu repodaki hatayı düzelt" }));
    expect(r.resultStatus).toBe("VERIFIED");
    expect(r.evidence.map((e) => e.kind).sort()).toEqual(["diff", "pr", "test"]);
    expect(r.approvalIds).toEqual(["ap_a", "ap_b"]);
    expect(r.costUsd).toBe(0.5);
  });
  it("kod işi (girdiden): hiç araç yok → UNVERIFIED", () => {
    expect(buildReceipt(run("COMPLETED", [], { goal: "fix the bug" })).resultStatus).toBe("UNVERIFIED");
  });
  it.each([
    ["PR yok", [DIFF, TEST_OK]],
    ["test yok", [DIFF, PR]],
    ["diff yok", [TEST_OK, PR]],
    ["test başarısız", [DIFF, tc("c2", "run_tests", "COMPLETED", { exitCode: 1 }), PR]],
    ["test çıktısı belirsiz", [DIFF, tc("c2", "run_tests", "COMPLETED", {}), PR]],
    ["test aracı FAILED", [DIFF, tc("c2", "run_tests", "FAILED"), PR]],
    ["PR çağrısı URL'siz", [DIFF, TEST_OK, tc("c3", "create_pr", "COMPLETED", {})]],
  ])("kod işi, kanıt eksik (%s) → UNVERIFIED", (_n, calls) => {
    expect(buildReceipt(run("COMPLETED", calls)).resultStatus).toBe("UNVERIFIED");
  });
  it("kod dışı iş + kanıt yok → UNVERIFIED (fail-closed)", () => {
    expect(buildReceipt(run("COMPLETED", [tc("x", "web_search")])).resultStatus).toBe("UNVERIFIED");
  });
  it("FAILED ve CANCELLED → resultStatus null", () => {
    expect(buildReceipt(run("FAILED", [DIFF, TEST_OK, PR])).resultStatus).toBeNull();
    expect(buildReceipt(run("CANCELLED", [])).resultStatus).toBeNull();
  });
  it("sızıntı yok: ham çıktı ve URL sorgusu makbuza girmez", () => {
    const json = JSON.stringify(buildReceipt(run("COMPLETED", [DIFF, TEST_OK, PR])));
    expect(json).not.toContain("SECRET");
    expect(json).toContain("https://github.com/o/r/pull/7");
  });
  it("içerik özeti deterministik", () => {
    const a = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, PR]));
    const b = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, PR]));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── transitionRun entegrasyonu ───────────────────────────────────────────
function fake(opts: { failCreate?: boolean; failLog?: boolean; raceLoss?: boolean } = {}) {
  const row = { id: "run_1", status: "RUNNING", state: "RUNNING" as string | null };
  const receipts: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const client = {
    run: {
      findFirst: async (args: { select: Record<string, unknown>; where: { id: string } }) => {
        if (args.where.id !== "run_1") return null;
        if ("toolCalls" in ((args.select.steps as { select?: object })?.select ?? {})) {
          return { costUsd: 1, input: { goal: "fix bug" }, approvals: [], steps: [{ toolCalls: [DIFF] }] };
        }
        return { status: row.status, state: row.state };
      },
      updateMany: async () => {
        if (opts.raceLoss) return { count: 0 };
        row.status = "COMPLETED"; row.state = "COMPLETED";
        return { count: 1 };
      },
    },
    jobReceipt: {
      findFirst: async (a: { where: { runId: string; outcome: string } }) =>
        receipts.find((r) => r.runId === a.where.runId && r.outcome === a.where.outcome) ?? null,
      create: async (a: { data: Record<string, unknown> }) => {
        if (opts.failCreate) throw new Error("db down");
        receipts.push(a.data);
        return { id: `rc_${receipts.length}` };
      },
    },
    activityLog: {
      create: async (a: { data: Record<string, unknown> }) => {
        if (opts.failLog) throw new Error("log down");
        logs.push(a.data);
        return {};
      },
    },
  };
  return { client: client as unknown as RunTransitionClient, row, receipts, logs };
}
const on = { tenantId: "t1", dualWrite: true } as const;

describe("transitionRun → makbuz", () => {
  it("bayrak açık, COMPLETED → bir makbuz yazılır", async () => {
    const f = fake();
    const r = await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(r).toMatchObject({ ok: true, noop: false });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ runId: "run_1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "UNVERIFIED" });
  });
  it("bayrak kapalı → hiçbir şey yazılmaz", async () => {
    const f = fake();
    await transitionRun(f.client, "run_1", "COMPLETED", { tenantId: "t1", dualWrite: false });
    expect(f.receipts).toHaveLength(0);
  });
  it("CAS kaybı → makbuz yok", async () => {
    const f = fake({ raceLoss: true });
    const r = await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(r).toMatchObject({ ok: false, reason: "lost_race" });
    expect(f.receipts).toHaveLength(0);
  });
  it("idempotent: aynı sonuç için ikinci makbuz yazılmaz", async () => {
    const f = fake();
    await transitionRun(f.client, "run_1", "COMPLETED", on);
    f.row.status = "RUNNING"; f.row.state = "RUNNING"; // tekrar gelen teslimat aynı geçişi yeniden kazansa bile
    await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(f.receipts).toHaveLength(1);
  });
  it("makbuz hatası geçişi bozmaz; activity_log uyarısı yazılır", async () => {
    const f = fake({ failCreate: true });
    const r = await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(r).toMatchObject({ ok: true, noop: false });
    expect(f.row.status).toBe("COMPLETED");
    expect(f.logs[0]).toMatchObject({ action: "run.receipt_failed", resourceId: "run_1" });
  });
  it("makbuz hatası + log hatası da geçişi bozmaz", async () => {
    const f = fake({ failCreate: true, failLog: true });
    expect(await transitionRun(f.client, "run_1", "COMPLETED", on)).toMatchObject({ ok: true });
  });
  it("terminal olmayan geçiş (PAUSED) makbuz yazmaz", async () => {
    const f = fake();
    await transitionRun(f.client, "run_1", "PAUSED", on);
    expect(f.receipts).toHaveLength(0);
  });
});
