/**
 * BRA-P0-04c — buildReceipt (saf) + terminal geçişte makbuz yazımı (sahte istemci, DB yok).
 * Gerçek Postgres davranışı (RLS, append-only) bu dosyada KANITLANMAZ.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildReceipt, deriveStepModels, toJobReceiptDto, type ReceiptRunInput, type ReceiptToolCall } from "../receipt";
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
  it("get_github_pr_status salt-okur durum sorgusu: PR kanıtı DEĞİL → kod işi UNVERIFIED", () => {
    const st = tc("c3", "get_github_pr_status", "COMPLETED", { status: "COMPLETED", pr: { url: "https://github.com/o/r/pull/9" } });
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, st]));
    expect(r.evidence.some((e) => e.kind === "pr")).toBe(false);
    expect(r.resultStatus).toBe("UNVERIFIED");
    expect(buildReceipt(run("COMPLETED", [st], { goal: "fix bug" })).resultStatus).toBe("UNVERIFIED");
  });
  it("create_pull_request çıktısındaki PR URL'si kanıttır", () => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, tc("c3", "create_pull_request", "COMPLETED", { pr: { url: "https://github.com/o/r/pull/9" } })]));
    expect(r.resultStatus).toBe("VERIFIED");
  });
  it.each([
    ["exitCode 0 + passed:false", { exitCode: 0, passed: false }],
    ["exitCode 0 + failed>0", { exitCode: 0, failed: 2 }],
  ])("test %s geçmemiş sayılır", (_n, out) => {
    const r = buildReceipt(run("COMPLETED", [DIFF, tc("c2", "run_tests", "COMPLETED", out), PR]));
    expect(r.resultStatus).toBe("UNVERIFIED");
  });
  it("büyük harfli araç adı (Run_Tests) başarısızsa veto eder", () => {
    const r = buildReceipt(run("COMPLETED", [DIFF, TEST_OK, tc("c9", "Run_Tests", "COMPLETED", { exitCode: 1 }), PR]));
    expect(r.resultStatus).toBe("UNVERIFIED");
  });
  it("DB sorgusu araç adını küçük/büyük harf duyarsız eşler", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const { writeReceipt } = await import("../receipt");
    await writeReceipt({ run: { findFirst }, jobReceipt: { findFirst: vi.fn(), create: vi.fn() } }, "r", "COMPLETED", "t1");
    const where = findFirst.mock.calls[0][0].select.steps.select.toolCalls.where;
    expect(where.OR).toContainEqual({ toolName: { equals: "run_tests", mode: "insensitive" } });
    expect(JSON.stringify(where)).not.toContain("get_github_pr_status");
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

describe("BRA-P0-06c — adım başına sağlayıcı/model", () => {
  const stepRun = (stepModels: ReceiptRunInput["stepModels"], steps: ReceiptRunInput["steps"] = [], outcome: ReceiptRunInput["outcome"] = "COMPLETED"): ReceiptRunInput => ({
    id: "run_1", tenantId: "t1", outcome, costUsd: "0.5", input: {}, steps, stepModels, approvals: [],
  });
  it("her adım için step öğesi: ref step:<stepIndex>, provider ve model", () => {
    const r = buildReceipt(stepRun([
      { stepIndex: 0, status: "COMPLETED", provider: "anthropic", model: "claude-sonnet-4" },
      { stepIndex: 2, status: "COMPLETED", provider: "openai", model: "gpt-x" },
    ]));
    expect(r.evidence).toEqual([
      { kind: "step", ref: "step:0", provider: "anthropic", model: "claude-sonnet-4" },
      { kind: "step", ref: "step:2", provider: "openai", model: "gpt-x" },
    ]);
  });
  it("provider/model yoksa öğe üretilmez; stepModels verilmediyse evidence boş", () => {
    expect(buildReceipt(stepRun([{ stepIndex: 0 }, { stepIndex: 1, provider: null, model: null }])).evidence).toEqual([]);
    expect(buildReceipt(stepRun(undefined)).evidence).toEqual([]);
  });
  it("sağlayıcı/model dışı tür ve aşırı uzun değer atılır", () => {
    expect(deriveStepModels([{ stepIndex: 0, provider: 5, model: "m".repeat(101) }])).toEqual([]);
    expect(deriveStepModels([{ stepIndex: 0, provider: " p ", model: 7 }])).toEqual([{ kind: "step", ref: "step:0", provider: "p" }]);
  });
  it("aynı stepIndex için tek öğe: FAILED satırı başarılıyı ezmez, sonraki başarılı kazanır", () => {
    expect(deriveStepModels([
      { stepIndex: 1, status: "COMPLETED", provider: "a", model: "ok" },
      { stepIndex: 1, status: "FAILED", provider: "b", model: "bad" },
    ])).toEqual([{ kind: "step", ref: "step:1", provider: "a", model: "ok" }]);
    expect(deriveStepModels([
      { stepIndex: 1, status: "FAILED", provider: "b", model: "bad" },
      { stepIndex: 1, status: "COMPLETED", provider: "a", model: "ok" },
    ])).toEqual([{ kind: "step", ref: "step:1", provider: "a", model: "ok" }]);
    expect(deriveStepModels([
      { stepIndex: 1, status: "COMPLETED", provider: "a", model: "m1" },
      { stepIndex: 1, status: "COMPLETED", provider: "c", model: "m2" },
    ])).toEqual([{ kind: "step", ref: "step:1", provider: "c", model: "m2" }]);
    expect(deriveStepModels([
      { stepIndex: 1, status: "FAILED", provider: "b", model: "x" },
      { stepIndex: 1, status: "FAILED", provider: "d", model: "y" },
    ])).toEqual([{ kind: "step", ref: "step:1", provider: "d", model: "y" }]);
  });
  it("60+ adım: step öğeleri 50'de kesilir; toplam evidence ≤ 100 ve kanıt örneklemesi bozulmaz", () => {
    const stepModels = Array.from({ length: 70 }, (_, i) => ({ stepIndex: i, status: "COMPLETED", provider: "p", model: "m" }));
    const calls = [...Array.from({ length: 60 }, (_, i) => tc(`d${i}`, "git_commit")), TEST_OK, PR];
    const r = buildReceipt({ ...stepRun(stepModels, [{ toolCalls: calls }]), input: { goal: "fix" } });
    expect(r.evidence.filter((e) => e.kind === "step")).toHaveLength(50);
    expect(r.evidence.filter((e) => e.kind !== "step").length).toBeLessThanOrEqual(50);
    expect(r.evidence.length).toBeLessThanOrEqual(100);
    expect(r.resultStatus).toBe("VERIFIED");
  });
  it("step öğeleri VERIFIED'ı etkilemez: kanıtsız iş UNVERIFIED kalır, kanıtlı iş VERIFIED kalır", () => {
    const meta = [{ stepIndex: 0, status: "COMPLETED", provider: "anthropic", model: "m" }];
    expect(buildReceipt(stepRun(meta)).resultStatus).toBe("UNVERIFIED");
    const withEvidence = buildReceipt({ ...stepRun(meta, [{ toolCalls: [DIFF, TEST_OK, PR] }]), input: { goal: "fix" } });
    expect(withEvidence.resultStatus).toBe("VERIFIED");
    expect(withEvidence.evidence.filter((e) => e.kind === "step")).toHaveLength(1);
  });
  it("step öğesi contentHash'e girer ve aynı girdide kararlıdır", () => {
    const mk = (model: string) => buildReceipt(stepRun([{ stepIndex: 0, status: "COMPLETED", provider: "p", model }]));
    expect(mk("m1").contentHash).toBe(mk("m1").contentHash);
    expect(mk("m1").contentHash).not.toBe(mk("m2").contentHash);
  });
  it("writeReceipt: adım çıktısı TAM çekilmez; yalnız provider/model SQL ile, tenant+run kapsamlı", async () => {
    const { writeReceipt } = await import("../receipt");
    const findFirst = vi.fn().mockResolvedValue({ costUsd: null, input: {}, retryCount: 0, approvals: [], steps: [] });
    const create = vi.fn().mockResolvedValue({ id: "rc1" });
    const $queryRaw = vi.fn().mockResolvedValue([{ stepIndex: 0, status: "COMPLETED", provider: "anthropic", model: "m" }]);
    const r = await writeReceipt({ run: { findFirst }, $queryRaw, jobReceipt: { findFirst: vi.fn().mockResolvedValue(null), create } }, "run_9", "COMPLETED", "t7");
    expect(r.written).toBe(true);
    const sel = findFirst.mock.calls[0][0].select.steps.select;
    expect(sel.output).toBeUndefined();
    const [strings, ...vals] = $queryRaw.mock.calls[0];
    const sql = strings.join("?");
    expect(sql).toContain("output->>'provider'");
    expect(sql).toContain("c.tenant_id");
    expect(sql).toContain("ORDER BY rs.step_index ASC, rs.created_at ASC");
    expect(sql).not.toMatch(/finalContent|rs\.output\s*(,|AS|FROM)/);
    expect(vals).toContain("run_9");
    expect(vals).toContain("t7");
    expect(create.mock.calls[0][0].data.evidence).toEqual([{ kind: "step", ref: "step:0", provider: "anthropic", model: "m" }]);
  });
  it("writeReceipt: $queryRaw yoksa ya da düşerse makbuz yine yazılır (step öğesiz)", async () => {
    const { writeReceipt } = await import("../receipt");
    const mk = (extra: object) => {
      const create = vi.fn().mockResolvedValue({ id: "rc" });
      return { create, client: { run: { findFirst: vi.fn().mockResolvedValue({ costUsd: null, input: {}, retryCount: 0, approvals: [], steps: [] }) }, jobReceipt: { findFirst: vi.fn().mockResolvedValue(null), create }, ...extra } };
    };
    const a = mk({});
    expect((await writeReceipt(a.client, "r", "COMPLETED", "t")).written).toBe(true);
    const b = mk({ $queryRaw: vi.fn().mockRejectedValue(new Error("boom")) });
    expect((await writeReceipt(b.client, "r", "COMPLETED", "t")).written).toBe(true);
    expect(b.create.mock.calls[0][0].data.evidence).toEqual([]);
  });
  it("geri uyum: step öğesi içermeyen eski makbuz satırı aynen okunur", () => {
    const row = {
      id: "r1", runId: "run_1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: "0.5",
      evidence: [{ kind: "diff", ref: "tool_call:c1" }, { kind: "test", ref: "tool_call:c2", ok: true }],
      approvalIds: [], contentHash: "h", createdAt: new Date("2026-11-01T00:00:00Z"),
    };
    const dto = toJobReceiptDto(row);
    expect(dto.evidence).toEqual(row.evidence);
    expect(dto.evidence.every((e) => e.provider === undefined && e.model === undefined)).toBe(true);
    expect(dto.resultStatus).toBe("VERIFIED");
    expect(toJobReceiptDto({ ...row, evidence: null }).evidence).toEqual([]);
  });
  it("yeni makbuz satırı step öğelerini DTO'ya taşır", () => {
    const step = { kind: "step", ref: "step:0", provider: "anthropic", model: "m" };
    const dto = toJobReceiptDto({
      id: "r2", runId: "run_1", tenantId: "t1", outcome: "COMPLETED", resultStatus: "UNVERIFIED", costUsd: null,
      evidence: [step], approvalIds: [], contentHash: "h2", createdAt: new Date("2026-11-14T00:00:00Z"),
    });
    expect(dto.evidence).toEqual([step]);
  });
});
