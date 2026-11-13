/**
 * BRA-UX-05e — `GET /runs/:id/code-summary` yanıtının savunmacı ayrıştırıcısı. Sözleşme: bilinmeyen/yanlış tipli alan → null (0 UYDURULMAZ),
 * negatif/NaN/tam sayı olmayan → null, `files` dizi değilse boş, yolu dize olmayan dosya atılır. `complete`/`ok` yalnız açık `true` ile true.
 */
export interface CodeFileRow { path: string; additions: number | null; deletions: number | null }
export interface CodeDiffView { files: CodeFileRow[]; fileCount: number; additions: number | null; deletions: number | null; complete: boolean }
export interface CodeTestsView { passed: number | null; failed: number | null; skipped: number | null; total: number | null; ok: boolean; runs: number | null }
export interface CodeView { diff: CodeDiffView | null; tests: CodeTestsView | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parseDiff(raw: unknown): CodeDiffView | null {
  if (!isObj(raw)) return null;
  const files: CodeFileRow[] = [];
  if (Array.isArray(raw.files)) {
    for (const f of raw.files) {
      if (isObj(f) && typeof f.path === "string" && f.path.trim() !== "") files.push({ path: f.path, additions: count(f.additions), deletions: count(f.deletions) });
    }
  }
  const declared = count(raw.fileCount);
  return {
    files,
    fileCount: Math.max(declared ?? 0, files.length),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    complete: raw.complete === true,
  };
}

function parseTests(raw: unknown): CodeTestsView | null {
  if (!isObj(raw)) return null;
  return { passed: count(raw.passed), failed: count(raw.failed), skipped: count(raw.skipped), total: count(raw.total), ok: raw.ok === true, runs: count(raw.runs) };
}

/** Nesne olmayan yanıt → `null` (çağıran hata durumuna düşer); diff ve tests ikisi de yoksa kart "kayıt yok" der. */
export function parseCodeSummary(raw: unknown): CodeView | null {
  if (!isObj(raw)) return null;
  return { diff: parseDiff(raw.diff), tests: parseTests(raw.tests) };
}

export const hasCodeChange = (v: CodeView): boolean => v.diff !== null || v.tests !== null;
