/**
 * BRA-UX-05f — Şirket durumu GÖRÜNÜM katmanı (saf). Veri: `GET /runs?companyId=…&bucket=…` (BRA-P0-11a: sunucu şirkete süzer; istemci
 * süzmesi YOK). Kova sayısı sunucunun `counts` toplamıdır (sayfa kırpmasından bağımsız, kesin). Bir kova okunamadıysa ya da `counts`
 * gelmediyse sayı 0 DEĞİL "bilinmiyor"dur; hiçbir değer uydurulmaz. Maliyet yalnız yüklenen işlerin, geçerli Decimal METİN/sayı değerlerinin toplamıdır.
 */
import type { InboxBucket } from "@ai-company-os/core";
import type { InboxRunsPage } from "../inbox";
import { parseCostUsd } from "../ux-models/models";

export const SUMMARY_BUCKETS = ["working", "stuck", "needs_approval", "done"] as const satisfies readonly InboxBucket[];
export type SummaryBucket = (typeof SUMMARY_BUCKETS)[number];

/** `null` sayfa = o kova okunamadı. */
export type BucketPages = Record<SummaryBucket, InboxRunsPage | null>;

export interface BucketCount {
  /** null → bilinmiyor (kova okunamadı). */
  count: number | null;
  /** Sunucu toplamı kesindir; bugün hep false (alan, arayüz sözleşmesi için kalır). */
  partial: boolean;
}

export interface CompanySummary {
  counts: Record<SummaryBucket, BucketCount>;
  /** Yüklenen şirket işlerinin maliyet toplamı (USD); hiçbir işin maliyeti okunamadıysa null. */
  costUsd: number | null;
  /** Maliyeti okunamayan (null/bozuk) iş sayısı. */
  costUnknownRuns: number;
  /** Toplam maliyetin bazı kovalar okunamadığı ya da sayfalar kısmi olduğu için eksik olabileceği. */
  costPartial: boolean;
}

export function summarizeCompany(pages: BucketPages): CompanySummary {
  const counts = {} as Record<SummaryBucket, BucketCount>;
  let micro = 0;
  let known = 0;
  let unknownCost = 0;
  let partial = false;
  let untrusted = false;
  for (const b of SUMMARY_BUCKETS) {
    const page = pages[b];
    if (!page) { counts[b] = { count: null, partial: false }; partial = true; continue; }
    const total = page.counts?.[b];
    counts[b] = { count: typeof total === "number" ? total : null, partial: false };
    if (typeof total !== "number") partial = true;
    if (page.nextCursor !== null) partial = true; // maliyet yalnız yüklenen sayfadan toplanır
    // `counts` yok = sunucu companyId'yi tanımamış olabilir (kiracı geneli koşu): bu sayfanın maliyeti HİÇ toplanmaz.
    if (page.counts === undefined) { untrusted = true; continue; }
    for (const r of page.runs) {
      const c = parseCostUsd(r.costUsd);
      if (c === null) unknownCost += 1;
      else { micro += Math.round(c * 1e6); known += 1; }
    }
  }
  // Şirketin hiç işi yoksa (tüm kovalar okundu, eşleşen iş yok) maliyet bilinmiyor değil 0'dır.
  const readable = SUMMARY_BUCKETS.every((b) => pages[b] !== null);
  const noJobs = readable && known === 0 && unknownCost === 0;
  return { counts, costUsd: untrusted ? null : known > 0 ? micro / 1e6 : noJobs ? 0 : null, costUnknownRuns: unknownCost, costPartial: partial };
}

export interface AgentRow { id: string; name: string; role: string | null }

/** `GET /companies/:id` → ajan satırları; bozuk/eksik yanıt çökertmez. */
export function toAgentRows(company: unknown): AgentRow[] {
  const agents = (company as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((a): a is { id: string; name: string; role?: unknown } => !!a && typeof a.id === "string" && typeof a.name === "string" && a.name.trim() !== "")
    .map((a) => ({ id: a.id, name: a.name, role: typeof a.role === "string" && a.role.trim() !== "" ? a.role : null }));
}

export function companyName(company: unknown): string | null {
  const n = (company as { name?: unknown } | null)?.name;
  return typeof n === "string" && n.trim() !== "" ? n : null;
}
