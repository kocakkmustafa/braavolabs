/**
 * BRA-UX-05f — Şirket durumu GÖRÜNÜM katmanı (saf). Veri: `GET /runs?bucket=…` (kiracı geneli, sayfa başına 25) şirket kimliğiyle
 * süzülür. Bir kova okunamadıysa sayı 0 DEĞİL "bilinmiyor"dur; sonraki sayfa varsa sayı "en az" (`partial`) işaretlidir; hiçbir değer
 * uydurulmaz. Maliyet yalnız yüklenen işlerin, geçerli Decimal METİN/sayı değerlerinin toplamıdır.
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
  /** true → sonraki sayfa var: gerçek sayı bundan büyük olabilir ("en az"). */
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

export function summarizeCompany(companyId: string, pages: BucketPages): CompanySummary {
  const counts = {} as Record<SummaryBucket, BucketCount>;
  let micro = 0;
  let known = 0;
  let unknownCost = 0;
  let partial = false;
  for (const b of SUMMARY_BUCKETS) {
    const page = pages[b];
    if (!page) { counts[b] = { count: null, partial: false }; partial = true; continue; }
    const mine = page.runs.filter((r) => r?.pipeline?.company?.id === companyId);
    counts[b] = { count: mine.length, partial: page.nextCursor !== null };
    if (page.nextCursor !== null) partial = true;
    for (const r of mine) {
      const c = parseCostUsd(r.costUsd);
      if (c === null) unknownCost += 1;
      else { micro += Math.round(c * 1e6); known += 1; }
    }
  }
  // Şirketin hiç işi yoksa (tüm kovalar okundu, eşleşen iş yok) maliyet bilinmiyor değil 0'dır.
  const readable = SUMMARY_BUCKETS.every((b) => pages[b] !== null);
  const noJobs = readable && known === 0 && unknownCost === 0;
  return { counts, costUsd: known > 0 ? micro / 1e6 : noJobs ? 0 : null, costUnknownRuns: unknownCost, costPartial: partial };
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
