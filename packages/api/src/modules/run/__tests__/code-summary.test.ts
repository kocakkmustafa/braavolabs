/** BRA-UX-API-06 — kod işi özeti ayrıştırıcıları (saf birim testleri). */
import { describe, it, expect } from "vitest";
import {
  buildCodeSummary,
  cleanPath,
  MAX_SUMMARY_FILES,
  parseDiffCall,
  parseTestCounts,
  summarizeDiff,
  summarizeTests,
  type CodeSummaryToolCall,
} from "../code-summary";

const tc = (toolName: string, output: unknown, extra: Partial<CodeSummaryToolCall> = {}): CodeSummaryToolCall => ({
  toolName,
  status: "COMPLETED",
  output,
  ...extra,
});

const GIT_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old line",
  "+new line 1",
  "+new line 2",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -5 +5 @@",
  "-- yorum satırı gibi silinen",
  "+x",
].join("\n");

describe("cleanPath", () => {
  it("mutlak yol ve `..` reddedilir (ana makine dizin yapısı sızmaz)", () => {
    for (const bad of ["/Users/ad/proje/x.ts", "C:\\proje\\x.ts", "c:/proje/x.ts", "\\\\sunucu\\paylasim", "../../x", "src/../../x", "a\\..\\x"]) {
      expect(cleanPath(bad)).toBeNull();
    }
    expect(cleanPath("src/a..b/x.ts")).toBe("src/a..b/x.ts"); // `..` yalnız tam parça olarak reddedilir
  });
  it("a/ b/ öneki yalnız diff yollarında atılır; gerçek `a/` `b/` dizini korunur", () => {
    expect(cleanPath("b/src/x.ts", true)).toBe("src/x.ts");
    expect(cleanPath("b/src/x.ts")).toBe("b/src/x.ts");
    expect(parseDiffCall({ files: [{ path: "a/x.ts" }, { path: "b/x.ts" }] }, {}).map((f) => f.path)).toEqual(["a/x.ts", "b/x.ts"]);
  });
  it("a/ b/ ./ öneklerini atar, geçersizleri reddeder", () => {
    expect(cleanPath("b/src/x.ts", true)).toBe("src/x.ts");
    expect(cleanPath("./src/x.ts")).toBe("src/x.ts");
    expect(cleanPath("/dev/null")).toBeNull();
    expect(cleanPath("a\u0000b")).toBeNull();
    expect(cleanPath("x".repeat(301))).toBeNull();
    expect(cleanPath(42)).toBeNull();
    expect(cleanPath("   ")).toBeNull();
  });
});

describe("parseDiffCall", () => {
  it("birleşik git diff: dosya başına +/−, üstbilgi satırı ve `-- ` silinmiş satır doğru sayılır", () => {
    expect(parseDiffCall({ diff: GIT_DIFF }, {})).toEqual([
      { path: "src/auth.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 1 },
    ]);
  });
  it("çıktı düz metin (string) ise de ayrıştırır", () => {
    expect(parseDiffCall(GIT_DIFF, {})).toHaveLength(2);
  });
  it("git'siz birleşik diff: iki dosya", () => {
    const text = ["--- a/one.txt", "+++ b/one.txt", "@@ -1 +1 @@", "-a", "+b", "--- a/two.txt", "+++ b/two.txt", "@@ -1 +1,2 @@", " c", "+d"].join("\n");
    expect(parseDiffCall({ patch: text }, {})).toEqual([
      { path: "one.txt", additions: 1, deletions: 1 },
      { path: "two.txt", additions: 1, deletions: 0 },
    ]);
  });
  it("numstat: ikili dosyada sayı null", () => {
    expect(parseDiffCall({ stdout: "12\t4\tsrc/a.ts\n-\t-\timg/logo.png\n" }, {})).toEqual([
      { path: "src/a.ts", additions: 12, deletions: 4 },
      { path: "img/logo.png", additions: null, deletions: null },
    ]);
  });
  it("yapılandırılmış files[]: takma alan adları ve düz string yol", () => {
    const out = parseDiffCall(
      { files: [{ filename: "a.ts", insertions: 3, removed: 1 }, "b.ts", { path: "c.ts", additions: -5, deletions: 1.5 }, { nope: 1 }] },
      {},
    );
    expect(out).toEqual([
      { path: "a.ts", additions: 3, deletions: 1 },
      { path: "b.ts", additions: null, deletions: null },
      { path: "c.ts", additions: null, deletions: null }, // negatif/ondalık sayı reddedilir
    ]);
  });
  it("tek dosya aracı: yol çıktıdan ya da girdiden, sayı null; içerik okunmaz", () => {
    expect(parseDiffCall({ ok: true }, { path: "src/new.ts", content: "SIR=abc" })).toEqual([{ path: "src/new.ts", additions: null, deletions: null }]);
    expect(parseDiffCall({ path: "o.ts" }, { path: "i.ts" })).toEqual([{ path: "o.ts", additions: null, deletions: null }]);
  });
  it("CRLF satır sonları: git diff ve numstat doğru ayrışır", () => {
    expect(parseDiffCall({ diff: GIT_DIFF.replace(/\n/g, "\r\n") }, {})).toEqual([
      { path: "src/auth.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 1 },
    ]);
    expect(parseDiffCall({ stdout: "3\t1\tsrc/a.ts\r\n" }, {})).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });
  it("ikili dosya ve yeniden adlandırma: hunk yoksa sayı null (0 uydurulmaz)", () => {
    const text = [
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parseDiffCall({ diff: text }, {})).toEqual([
      { path: "logo.png", additions: null, deletions: null },
      { path: "new.ts", additions: null, deletions: null },
      { path: "c.ts", additions: 1, deletions: 1 },
    ]);
    const d = summarizeDiff([tc("git_diff", { diff: text })])!;
    expect(d.complete).toBe(false);
    expect(d).toMatchObject({ additions: 1, deletions: 1, fileCount: 3 });
  });
  it("`name` alanı dosya yolu sayılmaz", () => {
    expect(parseDiffCall({ files: [{ name: "John" }] }, {})).toEqual([]);
  });
  it("tanınmayan biçim → boş", () => {
    expect(parseDiffCall({ message: "done" }, {})).toEqual([]);
    expect(parseDiffCall(null, null)).toEqual([]);
    expect(parseDiffCall([1, 2], undefined)).toEqual([]);
  });
});

describe("summarizeDiff", () => {
  it("diff aracı yok / başarısız / tanınmayan çıktı → null", () => {
    expect(summarizeDiff([])).toBeNull();
    expect(summarizeDiff([tc("run_tests", { passed: true })])).toBeNull();
    expect(summarizeDiff([tc("git_diff", { diff: GIT_DIFF }, { status: "FAILED" })])).toBeNull();
    expect(summarizeDiff([tc("git_diff", { message: "x" })])).toBeNull();
  });
  it("toplamlar ve complete; büyük/küçük harf duyarsız araç adı", () => {
    const d = summarizeDiff([tc("Git_Diff", { diff: GIT_DIFF })])!;
    expect(d).toMatchObject({ fileCount: 2, additions: 3, deletions: 2, complete: true });
    expect(d.files.map((f) => f.path)).toEqual(["src/auth.ts", "src/b.ts"]);
  });
  it("sayısız dosya varsa complete=false, toplam yalnız bilinenlerden; hiç sayı yoksa toplam null", () => {
    const mixed = summarizeDiff([tc("git_diff", { files: [{ path: "a", additions: 2, deletions: 0 }, "b"] })])!;
    expect(mixed).toMatchObject({ additions: 2, deletions: 0, complete: false, fileCount: 2 });
    const none = summarizeDiff([tc("write_file", { path: "a.ts" })])!;
    expect(none).toMatchObject({ additions: null, deletions: null, complete: false, fileCount: 1 });
  });
  it("aynı yol: son çağrı kazanır (toplanmaz); sayılı kayıt sayısızla ezilmez", () => {
    const d = summarizeDiff([
      tc("git_diff", { files: [{ path: "a.ts", additions: 5, deletions: 5 }] }),
      tc("edit_file", { path: "a.ts" }),
      tc("git_diff", { files: [{ path: "b.ts", additions: 1, deletions: 0 }] }),
      tc("git_diff", { files: [{ path: "b.ts", additions: 2, deletions: 1 }] }),
    ])!;
    expect(d.files).toEqual([
      { path: "a.ts", additions: 5, deletions: 5 },
      { path: "b.ts", additions: 2, deletions: 1 },
    ]);
    expect(d).toMatchObject({ additions: 7, deletions: 6, complete: true });
  });
  it("dosya listesi kırpılır: fileCount gerçek, files üst sınırda, complete=false", () => {
    const files = Array.from({ length: MAX_SUMMARY_FILES + 5 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
    const d = summarizeDiff([tc("git_diff", { files })])!;
    expect(d.files).toHaveLength(MAX_SUMMARY_FILES);
    expect(d.fileCount).toBe(MAX_SUMMARY_FILES + 5);
    expect(d.additions).toBe(MAX_SUMMARY_FILES + 5);
    expect(d.complete).toBe(false);
  });
});

describe("parseTestCounts / summarizeTests", () => {
  it("yapılandırılmış alanlar", () => {
    expect(parseTestCounts({ passed: 41, failed: 0, skipped: 2, total: 43 })).toEqual({ passed: 41, failed: 0, skipped: 2, total: 43 });
    expect(parseTestCounts({ numPassedTests: 5, numFailedTests: 1, numPendingTests: 0 })).toEqual({ passed: 5, failed: 1, skipped: 0, total: 6 });
  });
  it("boolean `passed` sayı sayılmaz; failures dizisi uzunluğa çevrilir", () => {
    expect(parseTestCounts({ passed: true, exitCode: 0 })).toEqual({ passed: null, failed: null, skipped: null, total: null });
    expect(parseTestCounts({ passed: 3, failures: ["a", "b"] })).toMatchObject({ passed: 3, failed: 2, total: 5 });
  });
  it("pytest / jest özet satırları", () => {
    expect(parseTestCounts({ stdout: "===== 41 passed, 2 skipped in 3.2s =====" })).toMatchObject({ passed: 41, skipped: 2, failed: null });
    expect(parseTestCounts("Tests:       1 failed, 40 passed, 41 total")).toEqual({ passed: 40, failed: 1, skipped: null, total: 41 });
  });
  it("Jest çok satırlı çıktı: `Test Suites` satırı değil `Tests:` satırı esas", () => {
    const out = "Test Suites: 1 failed, 4 passed, 5 total\nTests:       3 failed, 40 passed, 43 total\nSnapshots:   0 total\nTime: 2s";
    expect(parseTestCounts({ stdout: out })).toEqual({ passed: 40, failed: 3, skipped: null, total: 43 });
  });
  it("Vitest çok satırlı çıktı: `Test Files` satırı değil `Tests` satırı esas; (N) toplam", () => {
    const out = " Test Files  1 failed | 4 passed (5)\n      Tests  1 failed | 42 passed (43)\n   Duration  3s";
    expect(parseTestCounts(out)).toEqual({ passed: 42, failed: 1, skipped: null, total: 43 });
    const green = summarizeTests([tc("run_tests", { exitCode: 0, stdout: "Test Files  5 passed (5)\n Tests  43 passed (43)" })])!;
    expect(green).toMatchObject({ passed: 43, failed: 0, total: 43, ok: true });
  });
  it("ReDoS: 1 MB rakam/boşluk dizisi hızlı biter (doğrusal)", () => {
    const t0 = Date.now();
    parseTestCounts({ stdout: "1".repeat(1_000_000) });
    parseTestCounts({ stdout: "7" + " ".repeat(1_000_000) });
    parseDiffCall({ stdout: "1".repeat(1_000_000) }, {});
    parseDiffCall({ diff: "diff --git a/" + "x".repeat(1_000_000) }, {});
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("devasa diff metni (> sınır): complete=false", () => {
    const big = "x".repeat(1_000_001);
    const d = summarizeDiff([tc("git_diff", { files: [{ path: "a.ts", additions: 1, deletions: 0 }], diff: big })])!;
    expect(d.complete).toBe(false);
    expect(summarizeDiff([tc("git_diff", { files: [{ path: "a.ts", additions: 1, deletions: 0 }] })])!.complete).toBe(true);
  });
  it("callsTruncated ⇒ complete=false", () => {
    expect(summarizeDiff([tc("git_diff", { files: [{ path: "a.ts", additions: 1, deletions: 0 }] })], true)!.complete).toBe(false);
  });
  it("ok ile failed çelişmez: çıkış 0 olsa da failures[] / metinde `N failed` varsa ok=false", () => {
    expect(summarizeTests([tc("run_tests", { exitCode: 0, passed: 3, failures: ["a", "b"] })])).toMatchObject({ ok: false, failed: 2 });
    expect(summarizeTests([tc("run_tests", { exitCode: 0, stdout: "5 passed, 3 failed" })])).toMatchObject({ ok: false, failed: 3, passed: 5 });
  });
  it("test çağrısı yok → null; son çağrı esas, runs sayılır", () => {
    expect(summarizeTests([tc("git_diff", {})])).toBeNull();
    const t = summarizeTests([
      tc("run_tests", { passed: 3, failed: 2, exitCode: 1 }),
      tc("run_tests", { passed: 5, exitCode: 0 }),
    ])!;
    expect(t).toEqual({ passed: 5, failed: 0, skipped: null, total: 5, ok: true, runs: 2 });
  });
  it("başarısız son çağrı: ok=false, sayılar okunmaz", () => {
    const t = summarizeTests([tc("pytest", { passed: 9, exitCode: 0 }, { status: "FAILED" })])!;
    expect(t).toEqual({ passed: null, failed: null, skipped: null, total: null, ok: false, runs: 1 });
  });
  it("çıkış 0 ama başarısız > 0 → ok=false", () => {
    const t = summarizeTests([tc("run_tests", { passed: 4, failed: 1, exitCode: 0 })])!;
    expect(t.ok).toBe(false);
    expect(t.failed).toBe(1);
  });
  it("belirsiz çıktıda ok=false, sayı null (0 uydurulmaz)", () => {
    expect(summarizeTests([tc("run_tests", { stdout: "ran" })])).toEqual({ passed: null, failed: null, skipped: null, total: null, ok: false, runs: 1 });
  });
});

describe("buildCodeSummary — sızıntı", () => {
  it("yanıtta diff gövdesi, test çıktısı, girdi ve sır bulunmaz", () => {
    const secret = "sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const calls = [
      tc("git_diff", { diff: `${GIT_DIFF}\n+TOKEN=${secret}` }, { input: { token: secret } }),
      tc("write_file", { path: "x.ts" }, { input: { path: "x.ts", content: secret } }),
      tc("run_tests", { stdout: `1 passed ${secret}`, exitCode: 0 }),
    ];
    const s = buildCodeSummary("run-1", calls, new Date("2026-11-13T10:00:00Z"));
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(JSON.stringify(s)).not.toContain("new line");
    expect(Object.keys(s).sort()).toEqual(["diff", "generatedAt", "runId", "tests"]);
    expect(Object.keys(s.diff!).sort()).toEqual(["additions", "complete", "deletions", "fileCount", "files"]);
    expect(Object.keys(s.tests!).sort()).toEqual(["failed", "ok", "passed", "runs", "skipped", "total"]);
    expect(s.generatedAt).toBe("2026-11-13T10:00:00.000Z");
  });
  it("hiç kod aracı yok → diff ve tests null", () => {
    expect(buildCodeSummary("r", [], new Date(0))).toMatchObject({ runId: "r", diff: null, tests: null });
  });
});
