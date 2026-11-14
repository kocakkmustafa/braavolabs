/**
 * Compare measurement summary (BRA-P1-05a).
 *
 * `summarizeCompareMetrics` is a PURE function: it reads a finished
 * MultiModelCompareResult and returns a JSON-safe summary (per-candidate
 * duration / tokens / cost / error, plus totals and budget status). No I/O,
 * no clock, no mutation of its input. The summary is stored under
 * `findings.metrics`; older findings simply lack that key
 * (see `readCompareMetrics`).
 */
import type { MultiModelCompareResult } from "./multi-model";

export interface CandidateMetric {
  provider: string;
  model: string;
  ok: boolean;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: string | null;
}

export interface CompareMetrics {
  candidates: CandidateMetric[];
  totals: {
    candidateCount: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    candidateCostUsd: number;
    synthesizerCostUsd: number;
    totalCostUsd: number;
    /** Sum of successful candidates' durations (failed ones report none). */
    candidateDurationMs: number;
    /** Slowest successful candidate (parallel wall-clock proxy); 0 when none. */
    maxCandidateDurationMs: number;
    synthesizerDurationMs: number;
  };
  budget: {
    maxCostUsd: number | null;
    exceeded: boolean;
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function summarizeCompareMetrics(
  result: Pick<MultiModelCompareResult, "perModel" | "failed" | "synthesizer" | "totalCostUsd" | "budgetExceeded">,
  opts: { maxCostUsd?: number } = {},
): CompareMetrics {
  const ok: CandidateMetric[] = result.perModel.map((c) => ({
    provider: c.provider,
    model: c.model,
    ok: true,
    durationMs: num(c.durationMs),
    inputTokens: num(c.tokens?.input),
    outputTokens: num(c.tokens?.output),
    costUsd: num(c.costUsd),
    error: null,
  }));
  const bad: CandidateMetric[] = result.failed.map((f) => ({
    provider: f.provider,
    model: f.model,
    ok: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: f.error,
  }));
  const candidateCostUsd = ok.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const synthesizerCostUsd = num(result.synthesizer?.costUsd);
  const durations = ok.map((c) => c.durationMs ?? 0);
  const maxCostUsd = typeof opts.maxCostUsd === "number" && Number.isFinite(opts.maxCostUsd) ? opts.maxCostUsd : null;
  return {
    candidates: [...ok, ...bad],
    totals: {
      candidateCount: ok.length + bad.length,
      succeeded: ok.length,
      failed: bad.length,
      inputTokens: ok.reduce((s, c) => s + (c.inputTokens ?? 0), 0),
      outputTokens: ok.reduce((s, c) => s + (c.outputTokens ?? 0), 0),
      candidateCostUsd,
      synthesizerCostUsd,
      totalCostUsd: num(result.totalCostUsd),
      candidateDurationMs: durations.reduce((s, d) => s + d, 0),
      maxCandidateDurationMs: durations.length ? Math.max(...durations) : 0,
      synthesizerDurationMs: num(result.synthesizer?.durationMs),
    },
    budget: {
      maxCostUsd,
      exceeded: result.budgetExceeded === true || (maxCostUsd !== null && num(result.totalCostUsd) > maxCostUsd),
    },
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const TOTAL_KEYS = [
  "candidateCount", "succeeded", "failed", "inputTokens", "outputTokens", "candidateCostUsd",
  "synthesizerCostUsd", "totalCostUsd", "candidateDurationMs", "maxCandidateDurationMs", "synthesizerDurationMs",
] as const;

function isCandidateMetric(c: unknown): boolean {
  return (
    isObj(c) && isStr(c.provider) && isStr(c.model) && typeof c.ok === "boolean" &&
    isNumOrNull(c.durationMs) && isNumOrNull(c.inputTokens) && isNumOrNull(c.outputTokens) &&
    isNumOrNull(c.costUsd) && (c.error === null || isStr(c.error))
  );
}

/**
 * Back-compat + trust-boundary reader: legacy findings (no `metrics`) and
 * malformed/forged ones (findings can originate from LLM output) yield null.
 */
export function readCompareMetrics(findings: unknown): CompareMetrics | null {
  if (!isObj(findings)) return null;
  const m = findings.metrics;
  if (!isObj(m) || !Array.isArray(m.candidates) || !m.candidates.every(isCandidateMetric)) return null;
  const t = m.totals;
  if (!isObj(t) || !TOTAL_KEYS.every((k) => isNum(t[k]))) return null;
  const b = m.budget;
  if (!isObj(b) || typeof b.exceeded !== "boolean" || !isNumOrNull(b.maxCostUsd)) return null;
  return m as unknown as CompareMetrics;
}

/**
 * `metrics` is written only by our own code. Drop any `metrics` key that
 * arrived inside LLM-produced findings so a model cannot forge it.
 */
export function stripUntrustedMetrics<T>(findings: T): T {
  if (!isObj(findings) || !("metrics" in findings)) return findings;
  const { metrics: _drop, ...rest } = findings as Record<string, unknown>;
  return rest as T;
}
