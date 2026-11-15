/**
 * BRA-P0-11c — şirket aylık bütçesi: Company.config.monthlyBudgetUsd (migration yok).
 * Saf yardımcılar; DB/IO yok, asla throw etmez.
 */
export const BUDGET_CONFIG_KEY = "monthlyBudgetUsd";
export const MAX_MONTHLY_BUDGET_USD = 1_000_000;
export const BUDGET_WARN_PCT = 80;
export type BudgetState = "none" | "ok" | "warn" | "over";

export interface BudgetStatus {
  limitUsd: number | null;
  spentUsd: number | null;
  remainingUsd: number | null;
  usedPct: number | null;
  state: BudgetState;
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

/** Harcamayı limitle kıyaslar. Bölme-sıfır yok; limit 0 + harcama > 0 -> over, usedPct null. */
export function computeBudgetStatus(limitUsd: number | null, spentUsd: number | null): BudgetStatus {
  const limit = typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0 ? limitUsd : null;
  const spent = typeof spentUsd === "number" && Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : null;
  if (limit === null || spent === null) {
    return { limitUsd: limit, spentUsd: spent, remainingUsd: null, usedPct: null, state: "none" };
  }
  const remainingUsd = round2(limit - spent);
  if (limit === 0) {
    return { limitUsd: limit, spentUsd: spent, remainingUsd, usedPct: null, state: spent > 0 ? "over" : "ok" };
  }
  // Durum yuvarlanmamış değerlerle; usedPct yalnız gösterim (aşağı yuvarlanır, %100 görünümü over'a eşlik eder).
  const state: BudgetState =
    spent >= limit ? "over" : spent * 100 >= limit * BUDGET_WARN_PCT ? "warn" : "ok";
  const usedPct = Math.floor((spent * 100 / limit) * 100 + 1e-9) / 100;
  return { limitUsd: limit, spentUsd: spent, remainingUsd, usedPct, state };
}
