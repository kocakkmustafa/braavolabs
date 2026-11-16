/**
 * BRA-P0-11d — Şirket "tek bakış" GÖRÜNÜM katmanı (saf). `null` her yerde "Bilinmiyor" (i18n) olarak gösterilir; 0 DEĞİL.
 * Bütçe: none/ok/warn/over → rozet tonu + metin anahtarı; usedPct null olabilir (limit 0 + harcama>0 ⇒ over, yüzde yok).
 */
import type { CompanyBucketKey, CompanyBudgetState, CompanySummaryData } from "./parse";
import { COMPANY_BUCKET_KEYS } from "./parse";

export type BudgetTone = "muted" | "cyan" | "amber" | "red";

export const BUDGET_BADGE: Record<CompanyBudgetState, { tone: BudgetTone; labelKey: CompanyBudgetState }> = {
  none: { tone: "muted", labelKey: "none" },
  ok: { tone: "cyan", labelKey: "ok" },
  warn: { tone: "amber", labelKey: "warn" },
  over: { tone: "red", labelKey: "over" },
};

export interface BudgetView {
  state: CompanyBudgetState;
  tone: BudgetTone;
  labelKey: CompanyBudgetState;
  limitUsd: string | null;
  spentUsd: string | null;
  remainingUsd: string | null;
  /** Gösterilecek yüzde (null → yüzde yok). */
  usedPct: number | null;
  /** Çubuk dolumu 0..100; none → null (çubuk çizilmez); over ve yüzde yok → 100. */
  barPct: number | null;
}

export interface CompanySummaryView {
  agents: number | null;
  pipelines: number | null;
  pendingApprovals: number | null;
  buckets: { key: CompanyBucketKey; count: number | null }[];
  monthCostUsd: string | null;
  /** null → Bilinmiyor. */
  budget: BudgetView | null;
}

export function toBudgetView(b: NonNullable<CompanySummaryData["budget"]>): BudgetView {
  const { tone, labelKey } = BUDGET_BADGE[b.state];
  let barPct: number | null = null;
  if (b.state === "over") barPct = 100;
  else if (b.state !== "none") barPct = b.usedPct === null ? null : Math.min(100, Math.max(0, b.usedPct));
  return {
    state: b.state, tone, labelKey,
    limitUsd: b.limitUsd, spentUsd: b.spentUsd, remainingUsd: b.remainingUsd,
    usedPct: b.usedPct, barPct,
  };
}

export function toCompanySummaryView(d: CompanySummaryData): CompanySummaryView {
  return {
    agents: d.agents,
    pipelines: d.pipelines,
    pendingApprovals: d.pendingApprovals,
    buckets: COMPANY_BUCKET_KEYS.map((key) => ({ key, count: d.buckets[key] })),
    monthCostUsd: d.monthCostUsd,
    budget: d.budget ? toBudgetView(d.budget) : null,
  };
}
