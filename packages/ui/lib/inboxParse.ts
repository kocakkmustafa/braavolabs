/**
 * BRA-P0-04e — /runs ve /approvals yanıt ayrıştırıcıları. SAF ve core-RUNTIME-bağımsız: `lib/api.ts` (herkese açık
 * sayfaların yüklediği zincir) bunu import eder; `@ai-company-os/core` değerleri yalnız `lib/inbox.ts`te kalır.
 */
import type { InboxApprovalGroup, InboxApprovalGroupsPage, InboxBucketCounts, InboxRun, InboxRunsPage } from "./inbox";

const COUNT_BUCKETS = ["working", "needs_approval", "done", "stuck"] as const;

/** Yanıt şekli beklenenden farklıysa FIRLATIR: sessiz boş liste yok (UI hata durumu gösterir). */
export class InboxShapeError extends Error {
  constructor(what: string) { super(`Unexpected ${what} response shape`); this.name = "InboxShapeError"; }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cursorOf = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new InboxShapeError(what);
};

/** GET /runs → `{ runs, nextCursor }` GÖVDEDE (X-Next-Cursor başlığı YOK). */
export function parseRunsPage(raw: unknown): InboxRunsPage {
  if (!isObj(raw) || !Array.isArray(raw.runs)) throw new InboxShapeError("runs");
  for (const r of raw.runs) if (!isObj(r) || typeof r.id !== "string" || typeof r.status !== "string") throw new InboxShapeError("runs");
  const page: InboxRunsPage = { runs: raw.runs as InboxRun[], nextCursor: cursorOf(raw.nextCursor, "runs") };
  const counts = parseCounts(raw.counts);
  if (counts) page.counts = counts;
  return page;
}

/** Bozuk/negatif/ondalık sayı ya da yanlış tip → o kova yok (bilinmiyor); 0 uydurulmaz. */
function parseCounts(raw: unknown): InboxBucketCounts | null {
  if (!isObj(raw)) return null;
  const out: InboxBucketCounts = {};
  for (const b of COUNT_BUCKETS) {
    const v = raw[b];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[b] = v;
  }
  return out;
}

/** GET /approvals?groupBy=run → `{ groups, nextCursor }` GÖVDEDE. (Düz mod: dizi + X-Next-Cursor başlığı.) */
export function parseApprovalGroupsPage(raw: unknown): InboxApprovalGroupsPage {
  if (!isObj(raw) || !Array.isArray(raw.groups)) throw new InboxShapeError("approval groups");
  for (const g of raw.groups) {
    if (!isObj(g) || typeof g.runId !== "string" || !Array.isArray(g.approvals)) throw new InboxShapeError("approval groups");
    for (const a of g.approvals) if (!isObj(a) || typeof a.id !== "string") throw new InboxShapeError("approval groups");
  }
  return { groups: raw.groups as InboxApprovalGroup[], nextCursor: cursorOf(raw.nextCursor, "approval groups") };
}

/** Düz modda imleç başlıkta; başlığı olmayan/boş değer = son sayfa. */
export function cursorFromHeaders(h: { get(name: string): string | null }): string | null {
  const v = h.get("X-Next-Cursor");
  return v && v.length > 0 ? v : null;
}
