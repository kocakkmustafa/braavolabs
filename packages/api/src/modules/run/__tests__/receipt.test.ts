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
const PR = tc("c3", "create_pull_request", "COMPLETED", { html_url: "https://github.com/o/r/pull/7?token=SECRET#x" });
const DIFF = tc("c1", "git_commit");
const TEST_OK = tc("c2", "run_tests", "COMPLETED", { exitCode: 0, stdout: "SECRET RAW OUTPUT" });

describe("buildReceipt — sahte kanıt ve veto", () => {
  it.each(["create_product", "send_test_email", "open_project", "create_pr", "git_commit_all", "latest_patch", "write_file_x"])(
    "taklit araç adı %s kanıt üretmez",
    (name) => {
      const r = buildReceipt(run("COMPLETED", [tc("a", name, "COMPLETED", { exitCode: 0, success: true, passed: true, html_url: "https://github.com/o/r/pull/1" })], { goal: "fix bug" }));
      expect(r.evidence).toEqual([]);
      expect(r.resultStatus).toBe("UNVERIFIED");
    },
  );
  it("send_test_email {success:true} test kanıtı sayılmaz; kod dışı iş de UNVERIFIED", () => {
    expect(buildReceipt(run("COMPLETED", [tc("a", "send_test_email", "COMPLETED", { success: true })])).resultStatus).toBe("UNVERIFIED");
  });
  it("51+ tool_call: sondaki ok:false test VERIFIED'ı engeller ve saklanır", () => {
    const calls = [PR, TEST_OK, ...Array.from({ length: 60 }, (_, i) => tc(`d${i}`, "git_commit")), tc("bad", "run_tests", "COMPLETED", { exitCode: 2 })];
    const r = buildReceipt(run("COMPLETED", calls, { goal: "fix" }));
    expect(r.resultStatus).toBe("UNVERIFIED");
    expect(r.evidence.length).toBeLessThanOrEqual(50);
    expect(r.evidence.some((e) => e.kind === "test" && e.ok === false)).toBe(true);
  });
  it("saklanan liste kırpılsa da her tür örneklenir (VERIFIED yeniden türetilebilir)", () => {
    const calls = [...Array.from({ length: 60 }, (_, i) => tc(`d${i}`, "git_commit")), TEST_OK, PR];
    const r = buildReceipt(run("COMPLETED", calls, { goal: "fix" }));
    expect(r.resultStatus).toBe("VERIFIED");
    expect(new Set(r.evidence.map((e) => e.kind))).toEqual(new Set(["diff", "test", "pr"]));
  });
  it("girdi anahtar kelimesi (uzun girdinin sonunda) kod işi sayar → eksik kanıt UNVERIFIED", () => {
    const r = buildReceipt(run("COMPLETED", [], { notes: "x".repeat(9000) + " refactor" }));
    expect(r.resultStatus).toBe("UNVERIFIED");
  });
  it("kullanıcı girdisinde geçen PR URL'si kanıt değil", () => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, PR], { goal: "fix: bkz https://github.com/o/r/pull/7" }));
    expect(r.evidence.some((e) => e.kind === "pr")).toBe(false);
    expect(r.resultStatus).toBe("UNVERIFIED");
  });
  it.each([
    ["http", "http://github.com/o/r/pull/7"],
    ["yanlış host", "https://evil.com/o/r/pull/7"],
    ["alt alan adı", "https://github.com.evil.com/o/r/pull/7"],
    ["issue yolu", "https://github.com/o/r/issues/7"],
    ["PR numarasız", "https://github.com/o/r/pull/abc"],
    ["kimlik bilgisi", "https://u:p@github.com/o/r/pull/7"],
  ])("PR URL doğrulaması: %s reddedilir", (_n, url) => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, tc("c3", "create_pull_request", "COMPLETED", { html_url: url })]));
    expect(r.resultStatus).toBe("UNVERIFIED");
  });
  it.each(["https://gitlab.com/g/p/-/merge_requests/3", "https://bitbucket.org/w/r/pull-requests/9"])("geçerli sağlayıcı URL'si %s", (url) => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, tc("c3", "create_pull_request", "COMPLETED", { url })]));
    expect(r.resultStatus).toBe("VERIFIED");
  });
  it("get_github_pr_status çıktısındaki pr.url PR kanıtıdır", () => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, tc("c3", "get_github_pr_status", "COMPLETED", { status: "COMPLETED", pr: { url: "https://github.com/o/r/pull/9" } })]));
    expect(r.resultStatus).toBe("VERIFIED");
  });
  it("retry_count contentHash'e girer", () => {
    const a = buildReceipt({ ...run("FAILED", [DIFF]), retryCount: 0 });
    const b = buildReceipt({ ...run("FAILED", [DIFF]), retryCount: 1 });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

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
    ["PR çağrısı URL'siz", [DIFF, TEST_OK, tc("c3", "create_pull_request", "COMPLETED", {})]],
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
function fake(opts: { failCreate?: boolean; failLog?: boolean; raceLoss?: boolean; savepoint?: boolean; stored?: unknown[] } = {}) {
  const row = { id: "run_1", status: "RUNNING", state: "RUNNING" as string | null, resultStatus: undefined as unknown };
  const sql: string[] = [];
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
      updateMany: async (a: { data: { status?: string; state?: string; resultStatus?: unknown } }) => {
        if (opts.raceLoss) return { count: 0 };
        if (a.data.status) { row.status = a.data.status; row.state = a.data.state ?? row.state; }
        if (a.data.resultStatus !== undefined) row.resultStatus = a.data.resultStatus;
        return { count: 1 };
      },
    },
    jobReceipt: {
      findFirst: async (a: { where: { runId: string; outcome: string; contentHash?: string } }) =>
        receipts.find((r) => r.runId === a.where.runId && r.outcome === a.where.outcome && (a.where.contentHash === undefined || r.contentHash === a.where.contentHash)) ?? null,
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
  if (opts.savepoint) {
    Object.assign(client, { $executeRawUnsafe: async (q: string) => { sql.push(q); return 0; } });
  }
  return { client: client as unknown as RunTransitionClient, row, receipts, logs, sql };
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

describe("transitionRun → savepoint, Run.resultStatus, retry", () => {
  it("interaktif tx'te yazım SAVEPOINT … RELEASE ile sarılır", async () => {
    const f = fake({ savepoint: true });
    await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(f.sql).toEqual(["SAVEPOINT receipt_write", "RELEASE SAVEPOINT receipt_write"]);
    expect(f.receipts).toHaveLength(1);
  });
  it("create fırlatınca ROLLBACK TO SAVEPOINT çağrılır; geçiş ve sonraki sorgular etkilenmez", async () => {
    const f = fake({ savepoint: true, failCreate: true });
    const r = await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(r).toMatchObject({ ok: true, noop: false });
    expect(f.sql).toEqual(["SAVEPOINT receipt_write", "ROLLBACK TO SAVEPOINT receipt_write"]);
    expect(f.row.status).toBe("COMPLETED");
    expect(f.logs[0]).toMatchObject({ action: "run.receipt_failed" });
    // sonraki sorgu hâlâ çalışır
    f.row.status = "RUNNING"; f.row.state = "RUNNING";
    expect(await transitionRun(f.client, "run_1", "PAUSED", on)).toMatchObject({ ok: true });
  });
  it("$transaction'ı olan (düz prisma) istemcide savepoint kullanılmaz", async () => {
    const f = fake({ savepoint: true });
    Object.assign(f.client, { $transaction: async () => 0 });
    await transitionRun(f.client, "run_1", "COMPLETED", on);
    expect(f.sql).toEqual([]);
    expect(f.receipts).toHaveLength(1);
  });
  it("bayrak açık: makbuzun resultStatus'u Run.resultStatus'a yazılır (deriveResultStatus ana)", async () => {
    const f = fake();
    await transitionRun(f.client, "run_1", "COMPLETED", { ...on, resultStatus: "VERIFIED" });
    expect(f.receipts[0]).toMatchObject({ resultStatus: "UNVERIFIED" });
    expect(f.row.resultStatus).toBe("UNVERIFIED"); // çağıranın VERIFIED isteği ezildi
  });
  it("bayrak kapalı: Run.resultStatus'a dokunulmaz", async () => {
    const f = fake();
    await transitionRun(f.client, "run_1", "COMPLETED", { tenantId: "t1", dualWrite: false });
    expect(f.row.resultStatus).toBeUndefined();
  });
  it("FAILED → retry → FAILED: iki makbuz (retry_count farkı), FAILED'da resultStatus yazılmaz", async () => {
    const f = fake();
    const orig = f.client.run.findFirst;
    let retry = 0;
    f.client.run.findFirst = async (a: any) => {
      const r = await orig(a);
      return r && "retryCount" in (a.select ?? {}) ? { ...r, retryCount: retry } : r;
    };
    await transitionRun(f.client, "run_1", "FAILED", on);
    f.row.status = "RUNNING"; f.row.state = "RUNNING"; retry = 1;
    await transitionRun(f.client, "run_1", "FAILED", on);
    expect(f.receipts.filter((r) => r.outcome === "FAILED")).toHaveLength(2);
    expect(f.row.resultStatus).toBeUndefined();
  });
});
