/**
 * BRA-P0-11c — şirket aylık bütçesi: Company.config.monthlyBudgetUsd (migration yok).
 * Saf yardımcılar; DB/IO yok, asla throw etmez.
 *
 * NOT (BRA-P2-03d, bilgi): GET /companies/:id/summary `billing:budget` guard'ı TAŞIMAZ; router-wide
 * authMiddleware ile tüm tenant üyeleri (MEMBER dahil) okur. Limiti DEĞİŞTİREN PATCH /:id/budget ADMIN+
 * kalır. Okuma erişimini daraltmak rbac eylemi/kurucu kararıdır; burada değiştirilmedi.
 */
export const BUDGET_CONFIG_KEY = "monthlyBudgetUsd";
export const MAX_MONTHLY_BUDGET_USD = 1_000_000;
export const BUDGET_WARN_PCT = 80;
/** Yalnız öneri (uyarı eşiği); enforcement yok, karar kurucuda. */
export const BUDGET_SUGGESTED_ALERT_AT_PCT = BUDGET_WARN_PCT; // tek kaynak
export type BudgetState = "none" | "ok" | "warn" | "over";

export interface BudgetStatus {
  limitUsd: number | null;
  spentUsd: number | null;
  remainingUsd: number | null;
  usedPct: number | null;
  state: BudgetState;
  /** Önerilen uyarı eşiği (%); yalnız bilgi, salt-okur. */
  suggestedAlertAtPct: number;
}

export type BudgetValidation = { ok: true; value: number } | { ok: false; error: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 0 ya da ≥0.01 ve tam 2 ondalık; tolerans yalnız kayan nokta artığı için (göreli, EPSILON tabanlı). */
function isCentAligned(n: number): boolean {
  if (n === 0) return true;
  const cents = n * 100;
  const r = Math.round(cents);
  return r >= 1 && Math.abs(cents - r) <= r * Number.EPSILON * 8;
}

/** Gelen (güvenilmeyen) değeri doğrular: number, sonlu, 0..1_000_000, en çok 2 ondalık. */
export function validateBudgetInput(value: unknown): BudgetValidation {
  if (typeof value !== "number") return { ok: false, error: "monthlyBudgetUsd must be a number or null" };
  if (!Number.isFinite(value)) return { ok: false, error: "monthlyBudgetUsd must be a finite number" };
  if (value < 0) return { ok: false, error: "monthlyBudgetUsd must be >= 0" };
  if (value > MAX_MONTHLY_BUDGET_USD) {
    return { ok: false, error: `monthlyBudgetUsd must be <= ${MAX_MONTHLY_BUDGET_USD}` };
  }
  if (!isCentAligned(value)) return { ok: false, error: "monthlyBudgetUsd allows at most 2 decimal places" };
  return { ok: true, value: round2(value) };
}

/** config JSON'undan bütçeyi okur; bozuk/yok -> null. Asla throw etmez. */
export function parseMonthlyBudget(config: unknown): number | null {
  try {
    if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
    if (!Object.prototype.hasOwnProperty.call(config, BUDGET_CONFIG_KEY)) return null;
    const v = validateBudgetInput((config as Record<string, unknown>)[BUDGET_CONFIG_KEY]);
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

/**
 * Harcamayı limitle kıyaslar. Bölme-sıfır yok; limit 0 + harcama > 0 -> over, usedPct null.
 *
 * Para kuralı (BRA-P2-03d): USD; tüm hesap TAM SAYIYLA yapılır, float birikim hatası yok.
 * Limit -> cent (tam sayı); harcama -> mikro-USD (1e-6, Run.costUsd ölçeği). remainingUsd =
 * limit_cent - harcama_cent / 100 (harcama cente YARIM-YUKARI yuvarlanır). usedPct = harcama/limit*100,
 * 2 ondalığa AŞAĞI yuvarlanır (gösterim; >100 olabilir). Durum (warn/over) yuvarlanmamış mikro değerle.
 * Alt-cent limit (ör. 0.004) Math.round ile 0 cente iner -> limit-0 dalı; canlıda parseMonthlyBudget
 * 2 ondalık dayattığı için ULAŞILAMAZ, yalnız saf fonksiyon davranışı olarak sabitlenmiştir.
 * `suggestedAlertAtPct` yalnız ÖNERİDİR: uygulama/enforcement/yazma yok; eşik kararı kurucuda.
 */
export function computeBudgetStatus(limitUsd: number | null, spentUsd: number | null): BudgetStatus {
  const limit = typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0 ? limitUsd : null;
  const spent = typeof spentUsd === "number" && Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : null;
  const suggestedAlertAtPct = BUDGET_SUGGESTED_ALERT_AT_PCT;
  if (limit === null || spent === null) {
    return { limitUsd: limit, spentUsd: spent, remainingUsd: null, usedPct: null, state: "none", suggestedAlertAtPct };
  }
  const limitCents = Math.round(limit * 100);
  const spentMicro = Math.round(spent * 1_000_000);
  const spentCents = Math.floor((spentMicro + 5_000) / 10_000);
  const remainingUsd = (limitCents - spentCents) / 100;
  if (limitCents === 0) {
    return { limitUsd: limit, spentUsd: spent, remainingUsd, usedPct: null, state: spentMicro > 0 ? "over" : "ok", suggestedAlertAtPct };
  }
  const limitMicro = limitCents * 10_000;
  const state: BudgetState =
    spentMicro >= limitMicro ? "over" : spentMicro * 100 >= limitMicro * BUDGET_WARN_PCT ? "warn" : "ok";
  // yüzde*100 = spentMicro / limitCents (tam sayı bölme, aşağı)
  const usedPct = (spentMicro - (spentMicro % limitCents)) / limitCents / 100;
  return { limitUsd: limit, spentUsd: spent, remainingUsd, usedPct, state, suggestedAlertAtPct };
}
