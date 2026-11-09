/**
 * BRA-P0-04d — `POST /runs/:id/retry` kota kararı (ADR-0002/0003). Saf: I/O yok.
 *
 * Retry, "sonsuz retry yok" kuralının kapısıdır: yeniden başlatma denemesi
 * `retryCount + 1` kullanım sayılır ve `evaluateJobBudget` ile `maxRetries`
 * karşısında ölçülür (aşılırsa durur). Bütçesi olmayan koşuya da güvenli
 * varsayılan (`DEFAULT_MAX_RETRIES`) uygulanır. Usd/token/adım bütçesi zaten
 * tükenmiş bir koşu yeniden başlamaz (bozuk bütçe fail-closed).
 */
import { evaluateJobBudget, parseJobBudget, sumStepTokens, type BudgetVerdict } from "./job-budget";

/** `jobBudget.maxRetries` yoksa kullanıcı-tetikli retry için üst sınır. */
export const DEFAULT_MAX_RETRIES = 3;

export interface RetryBudgetInput {
  jobBudget: unknown;
  retryCount: number | null | undefined;
  costUsd: unknown;
  steps: ReadonlyArray<{ status: string; promptTokens?: number | null; completionTokens?: number | null }>;
}

export type RetryBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: string; stopped: string[] };

/** Retry sınırı: `evaluateRetryBudget` ile retry rotasının koşullu sayaç artışı AYNI limiti kullanır. */
export function retryLimit(jobBudget: unknown): number {
  const parsed = parseJobBudget(jobBudget);
  return (parsed.ok ? parsed.budget?.maxRetries : undefined) ?? DEFAULT_MAX_RETRIES;
}

export function evaluateRetryBudget(run: RetryBudgetInput): RetryBudgetDecision {
  const parsed = parseJobBudget(run.jobBudget);
  if (!parsed.ok) return { allowed: false, reason: "Job budget is invalid; run not restarted (fail-closed)", stopped: ["budget"] };
  const budget = { warnRatio: 0.8, ...(parsed.budget ?? {}) };
  const maxRetries = budget.maxRetries ?? DEFAULT_MAX_RETRIES;
  const verdict: BudgetVerdict = evaluateJobBudget(
    { ...budget, maxRetries },
    {
      usd: Number(run.costUsd ?? 0),
      tokens: sumStepTokens(run.steps),
      steps: run.steps.filter((s) => s.status === "COMPLETED").length,
      elapsedMs: 0, // timeoutMs bounds ONE leg (ADR-0002): a new leg starts fresh
      retries: (run.retryCount ?? 0) + 1, // this attempt
    },
  );
  if (verdict.action !== "stop") return { allowed: true };
  return { allowed: false, reason: verdict.reason ?? "Job budget exhausted", stopped: verdict.stopped };
}

/**
 * Yürütücünün hiyerarşik yola girdiği KOŞUL (pipeline/runner.ts) ve retry
 * rotasının reddettiği koşul tek yerde: ayrışmasın. Hiyerarşik retry (prior
 * COMPLETED delegasyon + maliyet tohumlama) BRA-P0-04j bileti.
 */
export function isHierarchicalPipeline(pipeline: { pipelineType?: string | null } | null | undefined): boolean {
  return pipeline?.pipelineType === "HIERARCHICAL";
}
