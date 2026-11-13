/**
 * BRA-UX-API-06 — kod işi makbuzu için salt-okur diff + test özeti.
 *
 * Kaynak: koşunun `tool_calls` satırları (yalnız `receipt.ts` izin listesindeki
 * diff/test araçları). Yeni tablo/kolon/yazma YOK; özet okuma anında türetilir.
 *
 * `buildCodeSummary` SAFTIR (I/O yok, saat dışarıdan). Çıktıda YALNIZ dosya yolu
 * ve sayılar bulunur: diff gövdesi, test stdout'u, dosya içeriği, araç girdisi
 * yanıta ASLA girmez (okunur, sayılır, atılır). Bilinmeyen sayı `null`'dır;
 * arayüz "Bilinmiyor" der, 0 uydurulmaz.
 *
 * Çıktı biçimi araçtan araca değişir (araçlar harici/MCP), bu yüzden ayrıştırıcı
 * dar ve hoşgörülüdür: (1) yapılandırılmış `files[]`, (2) birleşik diff metni
 * (`diff --git`/`+++ b/…`), (3) `git diff --numstat` satırları, (4) tek dosya
 * araçlarında `path` alanı. Tanınmayan biçim → o çağrıdan dosya çıkmaz.
 */
import type {
  JobCodeSummary,
  JobCodeSummaryDiff,
  JobCodeSummaryFile,
  JobCodeSummaryTests,
} from "@ai-company-os/core";
import { EVIDENCE_TOOLS, testPassed } from "./receipt";

export const MAX_SUMMARY_FILES = 200;
const MAX_PATH = 300;
const MAX_COUNT = 10_000_000;
/** Ayrıştırılacak diff metni üst sınırı (dev diff'ler bellek/CPU yemesin); aşılırsa `complete:false`. */
const MAX_TEXT = 1_000_000;
/** Test özet satırları çıktının SONUNDADIR: yalnız son bu kadar karakter taranır. */
const TEST_TAIL = 65_536;
/** Üstbilgi satırı üst sınırı (yol ≤300): uzun satırda regex hiç çalıştırılmaz. */
const MAX_HEADER_LINE = 1_000;
/** Bir koşudan okunan en çok araç çağrısı (en yeniler); aşılırsa `complete:false`. */
export const MAX_SUMMARY_CALLS = 200;
const LINE_SPLIT = /\r?\n/;

/** Özetin okuduğu araçlar: yalnız diff + test (PR aracı özete girmez, sorgu kotasını yemez). */
export const CODE_SUMMARY_TOOL_NAMES: readonly string[] = Object.keys(EVIDENCE_TOOLS).filter(
  (n) => EVIDENCE_TOOLS[n] === "diff" || EVIDENCE_TOOLS[n] === "test",
);

export interface CodeSummaryToolCall {
  toolName: string;
  status: string;
  input?: unknown;
  output?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Negatif olmayan tam sayı ya da null (NaN/Infinity/uçuk değer/ondalık reddedilir). */
function count(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return null;
  return v;
}

function firstCount(o: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const c = count(o[k]);
    if (c !== null) return c;
  }
  return null;
}

/**
 * Dosya yolu: kırpılmış, kontrol karakteri yok; mutlak yol ve `..` parçası reddedilir (ana makine
 * dizin yapısı sızmasın). `diffPrefix` yalnız birleşik diff yollarında `a/` `b/` önekini atar
 * (gerçek `a/` `b/` dizinleri yapılandırılmış yollarda korunur); `./` her zaman atılır.
 */
export function cleanPath(v: unknown, diffPrefix = false): string | null {
  if (typeof v !== "string") return null;
  let p = v.trim();
  if (!p || p === "/dev/null") return null;
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  if (diffPrefix) p = p.replace(/^(?:a|b)\//, "");
  p = p.replace(/^\.\//, "");
  if (!p || p.length > MAX_PATH) return null;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) return null;
  if (p.split(/[\\/]/).includes("..")) return null;
  return p;
}

function oversized(output: unknown): boolean {
  if (typeof output === "string") return output.length > MAX_TEXT;
  const o = asRecord(output);
  if (!o) return false;
  for (const k of ["diff", "patch", "output", "stdout", "text", "summary"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > MAX_TEXT) return true;
  }
  return false;
}

function textOf(output: unknown): string | null {
  if (typeof output === "string") return output.slice(0, MAX_TEXT);
  const o = asRecord(output);
  if (!o) return null;
  for (const k of ["diff", "patch", "output", "stdout", "text", "summary"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v.slice(0, MAX_TEXT);
  }
  return null;
}

/** Birleşik diff metni → dosya başına +/− (üstbilgi satırları sayılmaz). */
function parseUnifiedDiff(text: string): JobCodeSummaryFile[] {
  const files: JobCodeSummaryFile[] = [];
  const lines = text.split(LINE_SPLIT);
  let cur = null as JobCodeSummaryFile | null;
  let inHunk = false;
  let gitMode = false;
  // Sayı ilk `@@` görülünce bilinir; ikili/yeniden adlandırma dosyası `null` kalır (0 uydurulmaz).
  const open = (p: string | null): void => {
    cur = p ? { path: p, additions: null, deletions: null } : null;
    if (cur) files.push(cur);
    inHunk = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      const m = line.length <= MAX_HEADER_LINE ? /^diff --git a\/(.+?) b\/(.+)$/.exec(line) : null;
      // Regex `b/` önekini zaten yakalamadan atar (`a/b/foo` → `b/foo`): ikinci kez soyulmaz.
      gitMode = true;
      open(m ? cleanPath(m[2]) : null);
    } else if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ") && (lines[i + 2] ?? "").startsWith("@@")) {
      // Üstbilgi çifti: `--- a/x` `+++ b/y` `@@`. git kipinde dosya `diff --git` ile açıldı (çift yeni dosya AÇMAZ:
      // hunk içinde `-- x` / `++ y` / `@@` üçlüsü hayalet dosya doğurmasın); git'siz diff'te `+++` açar.
      const plus = cleanPath((lines[i + 1] ?? "").slice(4).split("\t")[0], true);
      if (!gitMode && (!cur || inHunk)) open(plus ?? cleanPath(line.slice(4).split("\t")[0], true));
      i += 1;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) {
      // `@@` gelmeden üstbilgi (ikili/yeniden adlandırma): sayılmaz
    } else if (line.startsWith("@@")) {
      inHunk = true;
      if (cur && cur.additions === null) {
        cur.additions = 0;
        cur.deletions = 0;
      }
    } else if (cur && inHunk) {
      if (line.startsWith("+")) cur.additions = (cur.additions ?? 0) + 1;
      else if (line.startsWith("-")) cur.deletions = (cur.deletions ?? 0) + 1;
    }
  }
  return files;
}

/** `git diff --numstat` satırları: `12\t4\tpath` (ikili dosyada `-\t-`). */
function parseNumstat(text: string): JobCodeSummaryFile[] {
  const files: JobCodeSummaryFile[] = [];
  for (const line of text.split(LINE_SPLIT)) {
    if (line.length > MAX_HEADER_LINE) continue;
    const m = /^(\d{1,9}|-)\t(\d{1,9}|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const path = cleanPath(m[3]);
    if (!path) continue;
    files.push({
      path,
      additions: m[1] === "-" ? null : count(Number(m[1])),
      deletions: m[2] === "-" ? null : count(Number(m[2])),
    });
  }
  return files;
}

const PATH_KEYS = ["path", "file", "filename", "file_path", "filePath"] as const;
const FILE_LIST_KEYS = ["files", "changed_files", "changedFiles", "changes"] as const;

function fileFromRecord(r: Record<string, unknown>): JobCodeSummaryFile | null {
  let path: string | null = null;
  for (const k of PATH_KEYS) {
    path = cleanPath(r[k]);
    if (path) break;
  }
  if (!path) return null;
  return {
    path,
    additions: firstCount(r, ["additions", "insertions", "added", "lines_added", "linesAdded"]),
    deletions: firstCount(r, ["deletions", "removed", "lines_removed", "linesRemoved"]),
  };
}

/** Tek diff aracı çağrısından dosyalar (tanınmayan biçim → boş). */
export function parseDiffCall(output: unknown, input: unknown): JobCodeSummaryFile[] {
  const o = asRecord(output);
  if (o) {
    for (const k of FILE_LIST_KEYS) {
      const list = o[k];
      if (!Array.isArray(list)) continue;
      const out: JobCodeSummaryFile[] = [];
      for (const item of list) {
        if (typeof item === "string") {
          const p = cleanPath(item);
          if (p) out.push({ path: p, additions: null, deletions: null });
        } else {
          const r = asRecord(item);
          const f = r ? fileFromRecord(r) : null;
          if (f) out.push(f);
        }
      }
      if (out.length > 0) return out;
    }
  }
  const text = textOf(output);
  if (text) {
    const unified = parseUnifiedDiff(text);
    if (unified.length > 0) return unified;
    const stat = parseNumstat(text);
    if (stat.length > 0) return stat;
  }
  // Tek dosya araçları (write_file/edit_file/…): yol çıktıda ya da girdide; sayı bilinmez.
  for (const src of [o, asRecord(input)]) {
    if (!src) continue;
    for (const k of PATH_KEYS) {
      const p = cleanPath(src[k]);
      if (p) return [{ path: p, additions: null, deletions: null }];
    }
  }
  return [];
}

/**
 * Çağrılar sırayla işlenir; aynı yol için SON çağrı kazanır (aynı dosyayı iki kez
 * düzenleyen iki `edit_file` toplanmaz). Sayısı bilinen kayıt, aynı yolun
 * sayısız kaydıyla ezilmez.
 */
export function summarizeDiff(calls: readonly CodeSummaryToolCall[], callsTruncated = false): JobCodeSummaryDiff | null {
  const byPath = new Map<string, JobCodeSummaryFile>();
  let sawDiffTool = false;
  let partial = callsTruncated;
  for (const c of calls) {
    if (EVIDENCE_TOOLS[String(c.toolName ?? "").toLowerCase()] !== "diff") continue;
    if (c.status !== "COMPLETED") continue;
    sawDiffTool = true;
    if (oversized(c.output)) partial = true; // metin kırpılarak okunur: sayılar eksik olabilir
    for (const f of parseDiffCall(c.output, c.input)) {
      // Son çağrı kazanır: sayılı eski kayıt sonradan gelen sayısız çağrıyla (ör. `edit_file`) ezilir ⇒ sayı
      // artık bayat olabilir, `null` (bilinmiyor) ve `complete:false`.
      byPath.delete(f.path); // sona taşı: son çağrı sırası
      byPath.set(f.path, f);
    }
  }
  if (!sawDiffTool || byPath.size === 0) return null;
  const all = [...byPath.values()];
  const files = all.slice(0, MAX_SUMMARY_FILES);
  const known = (pick: (f: JobCodeSummaryFile) => number | null): number | null => {
    let sum = 0;
    let any = false;
    for (const f of all) {
      const n = pick(f);
      if (n !== null) {
        sum += n;
        any = true;
      }
    }
    return any ? sum : null;
  };
  const complete = !partial && all.length <= MAX_SUMMARY_FILES && all.every((f) => f.additions !== null && f.deletions !== null);
  return {
    files,
    fileCount: all.length,
    additions: known((f) => f.additions),
    deletions: known((f) => f.deletions),
    complete,
  };
}

const TEXT_KEYS = ["stdout", "output", "text", "summary", "stderr"] as const;

/** Niceleyiciler sınırlı (`\d{1,9}`, `[ \t]{1,8}`): uzun rakam/boşluk dizisinde geri izleme patlamaz. */
function matchCount(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m ? count(Number(m[1])) : null;
}

/**
 * Jest (`Tests: 1 failed, 40 passed, 41 total`) ve Vitest (`Tests  1 failed | 42 passed (43)`) önce
 * `Tests` satırından okunur: `Test Suites`/`Test Files` satırı (dosya sayısı) test sayısı sayılmaz.
 * Satır yoksa (pytest vb.) son 64 KB'ın tamamı taranır.
 */
function summaryScope(text: string): string {
  const tail = text.length > TEST_TAIL ? text.slice(text.length - TEST_TAIL) : text;
  const lines = tail.split(LINE_SPLIT);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.length <= MAX_HEADER_LINE && /^[ \t]{0,16}Tests(?::|[ \t])/.test(l)) return l;
  }
  return tail;
}

/** Test çıktısı → sayılar (yapılandırılmış alanlar önce; yoksa pytest/jest/vitest özet satırı). */
export function parseTestCounts(output: unknown): Pick<JobCodeSummaryTests, "passed" | "failed" | "skipped" | "total"> {
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped: number | null = null;
  let total: number | null = null;
  const o = asRecord(output);
  if (o) {
    passed = firstCount(o, ["passed", "passes", "tests_passed", "testsPassed", "numPassedTests"]);
    failed = firstCount(o, ["failed", "failures", "tests_failed", "testsFailed", "numFailedTests"]);
    if (failed === null && Array.isArray(o.failures)) failed = o.failures.length;
    skipped = firstCount(o, ["skipped", "pending", "tests_skipped", "numPendingTests"]);
    total = firstCount(o, ["total", "tests", "tests_total", "numTotalTests"]);
  }
  const needText = passed === null || failed === null || skipped === null || total === null;
  if (needText) {
    let text: string | null = typeof output === "string" ? output : null;
    if (!text && o) {
      for (const k of TEXT_KEYS) {
        const v = o[k];
        if (typeof v === "string" && v) {
          text = v;
          break;
        }
      }
    }
    if (text) {
      const scope = summaryScope(text);
      passed ??= matchCount(scope, /(\d{1,9})[ \t]{1,8}passed\b/i);
      failed ??= matchCount(scope, /(\d{1,9})[ \t]{1,8}failed\b/i);
      skipped ??= matchCount(scope, /(\d{1,9})[ \t]{1,8}(?:skipped|pending)\b/i);
      total ??= matchCount(scope, /(\d{1,9})[ \t]{1,8}total\b/i) ?? matchCount(scope, /passed[ \t]{1,8}\((\d{1,9})\)/i);
    }
  }
  if (total === null && passed !== null && failed !== null) total = passed + failed + (skipped ?? 0);
  return { passed, failed, skipped, total };
}

/**
 * Sayılar SON test çağrısındandır (nihai durum); `ok` makbuzla aynı fail-closed kuraldır: TÜM test çağrıları
 * açıkça geçmeli (önce kaldı, sonra geçti ⇒ `ok:false`; makbuz da böyle veto eder). `runs` çağrı sayısıdır
 * (sorgu sınırı aşıldıysa "en az").
 */
export function summarizeTests(calls: readonly CodeSummaryToolCall[]): JobCodeSummaryTests | null {
  const testCalls = calls.filter((c) => EVIDENCE_TOOLS[String(c.toolName ?? "").toLowerCase()] === "test");
  if (testCalls.length === 0) return null;
  const last = testCalls[testCalls.length - 1]!;
  const counts = parseTestCounts(last.status === "COMPLETED" ? last.output : null);
  // Sayılar başarısızlık gösteriyorsa (ör. `failures: [..]`, metinde `3 failed`) çağrı geçmiş sayılmaz.
  const passes = (c: CodeSummaryToolCall): boolean =>
    c.status === "COMPLETED" && testPassed(c.output) && !((parseTestCounts(c.output).failed ?? 0) > 0);
  const ok = testCalls.every(passes);
  // Açıkça geçti (çıkış 0, başarısız yok) ve geçen sayısı biliniyorsa başarısız = 0 (veto yok).
  if (passes(last) && counts.failed === null && counts.passed !== null) counts.failed = 0;
  if (counts.total === null && counts.passed !== null && counts.failed !== null) {
    counts.total = counts.passed + counts.failed + (counts.skipped ?? 0);
  }
  return { ...counts, ok, runs: testCalls.length };
}

/** `callsTruncated`: sorgu üst sınırı aşıldı, en eski çağrılar okunmadı ⇒ diff `complete:false`. */
export function buildCodeSummary(
  runId: string,
  calls: readonly CodeSummaryToolCall[],
  now: Date,
  callsTruncated = false,
): JobCodeSummary {
  return {
    runId,
    diff: summarizeDiff(calls, callsTruncated),
    tests: summarizeTests(calls),
    generatedAt: now.toISOString(),
  };
}
