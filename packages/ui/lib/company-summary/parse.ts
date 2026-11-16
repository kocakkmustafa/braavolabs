/**
 * BRA-P0-11d — `GET /companies/:id/summary` savunmacı ayrıştırma (saf). Bozuk/eksik alan → null; sayı olmayan → null; uydurma 0 yok.
 * Sunucu şekli: packages/api/src/modules/company/summary.ts. Para değerleri Decimal METİN ya da sonlu sayı olabilir; metin olarak taşınır.
 */
export const COMPANY_BUCKET_KEYS = ["working", "needs_approval", "stuck", "done"] as const;
export type CompanyBucketKey = (typeof COMPANY_BUCKET_KEYS)[number];
export const BUDGET_STATES = ["none", "ok", "warn", "over"] as const;
export type CompanyBudgetState = (typeof BUDGET_STATES)[number];

export interface CompanyBudgetData {
  state: CompanyBudgetState;
  limitUsd: string | null;
  spentUsd: string | null;
  remainingUsd: string | null;
  usedPct: number | null;
}

export interface CompanySummaryData {
  agents: number | null;
  pipelines: number | null;
  buckets: Record<CompanyBucketKey, number | null>;
  pendingApprovals: number | null;
  monthCostUsd: string | null;
  /** null → sunucu bütçeyi vermedi/bozuk/bilinmeyen durum ("Bilinmiyor"); state:"none" sunucunun açık "bütçe yok" beyanıdır. */
  budget: CompanyBudgetData | null;
}

/** ≤15 tam hane, ≤12 ondalık: Number() ile sonlu kalır, hassasiyet/∞ riski yok. */
const MONEY_RE = /^-?\d{1,15}(\.\d{1,12})?$/;

/** Sonlu, tam sayı, ≥0 değilse null (0 uydurulmaz). */
export function toCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Decimal metin (`rakam[.rakam]`, isteğe bağlı eksi) ya da sonlu sayı → metin; aksi null. `allowNegative=false` iken negatif null. */
export function toMoney(v: unknown, allowNegative = false): string | null {
  let s: string | null = null;
  if (typeof v === "string") { const t = v.trim(); s = MONEY_RE.test(t) ? t : null; }
  else if (typeof v === "number" && Number.isFinite(v)) s = String(v);
  if (s === null || !MONEY_RE.test(s) || !Number.isFinite(Number(s))) return null; // üstel gösterim/aşırı hane reddedilir
  if (!allowNegative && s.startsWith("-")) return null;
  return s;
}

function toPct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function parseBudget(raw: unknown): CompanyBudgetData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const state = (BUDGET_STATES as readonly unknown[]).includes(b.state) ? (b.state as CompanyBudgetState) : null;
  if (state === null) return null; // bilinmeyen durum: rakamlara da güvenilmez, "bütçe yok" da denmez
  return {
    state,
    limitUsd: toMoney(b.limitUsd),
    spentUsd: toMoney(b.spentUsd),
    remainingUsd: toMoney(b.remainingUsd, true),
    usedPct: toPct(b.usedPct),
  };
}

/** Gövde nesne değilse null (kart "hata/boş" gösterir); alanlar tek tek savunmacı. */
export function parseCompanySummary(raw: unknown): CompanySummaryData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rb = r.buckets && typeof r.buckets === "object" && !Array.isArray(r.buckets) ? (r.buckets as Record<string, unknown>) : {};
  const buckets = {} as Record<CompanyBucketKey, number | null>;
  for (const k of COMPANY_BUCKET_KEYS) buckets[k] = toCount(rb[k]);
  return {
    agents: toCount(r.agents),
    pipelines: toCount(r.pipelines),
    buckets,
    pendingApprovals: toCount(r.pendingApprovals),
    monthCostUsd: toMoney(r.monthCostUsd),
    budget: parseBudget(r.budget),
  };
}
