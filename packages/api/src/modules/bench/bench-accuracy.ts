/**
 * Accuracy measurement wrapper (BRA-P1-05b).
 *
 * `runAccuracyBench` runs ONE fixed suite on up to MAX_CANDIDATES compare
 * candidates (ModelSelection, same type compare uses) via `runBenchSuite`,
 * sequentially so the cumulative cost ceiling can stop the remainder.
 * One record per candidate; `runBenchSuite` persists the BenchRun row
 * itself (runId links to it). A failing candidate is marked and never
 * affects the others. The runner is injectable (tests use a fake; no
 * network is reachable from this module on its own).
 */
import { runBenchSuite, type RunBenchOptions, type RunBenchResult } from "./bench.service";
import { MAX_CANDIDATES, type ModelSelection } from "../../services/multi-model";

export type AccuracyStatus = "ok" | "error" | "skipped" | "budget_skipped";

export interface AccuracyRecord {
  provider: string;
  model: string;
  status: AccuracyStatus;
  /** 0..1 for status "ok", else null. */
  scoreNormalised: number | null;
  /** Wall-clock of this candidate's run (measured here); 0 when never started. */
  durationMs: number;
  costUsd: number;
  /** BenchRun row id when persisted. */
  runId: string | null;
  error: string | null;
}

export interface AccuracyBenchResult {
  suiteSlug: string;
  records: AccuracyRecord[];
  totalCostUsd: number;
  budgetExceeded: boolean;
}

export interface AccuracyBenchOptions {
  suiteSlug: string;
  candidates: ModelSelection[];
  /** Total cost ceiling; once reached, remaining candidates do not run. */
  maxCostUsd?: number;
  notes?: string;
  /** Injection seam (default: the real runBenchSuite). */
  runner?: (opts: RunBenchOptions) => Promise<RunBenchResult>;
  now?: () => number;
}

const DEFAULT_MAX_COST_USD = 1.0;

export async function runAccuracyBench(opts: AccuracyBenchOptions): Promise<AccuracyBenchResult> {
  const runner = opts.runner ?? runBenchSuite;
  const now = opts.now ?? Date.now;
  const cap =
    typeof opts.maxCostUsd === "number" && Number.isFinite(opts.maxCostUsd) ? opts.maxCostUsd : DEFAULT_MAX_COST_USD;
  const candidates = opts.candidates.slice(0, MAX_CANDIDATES);

  const records: AccuracyRecord[] = [];
  let total = 0;
  let exceeded = false;

  for (const c of candidates) {
    const base = { provider: c.provider, model: c.model, scoreNormalised: null, durationMs: 0, costUsd: 0, runId: null, error: null };
    if (exceeded || total >= cap) {
      exceeded = true;
      records.push({ ...base, status: "budget_skipped" });
      continue;
    }
    const started = now();
    try {
      const r = await runner({
        suiteSlug: opts.suiteSlug,
        provider: c.provider as RunBenchOptions["provider"],
        model: c.model,
        notes: opts.notes,
      });
      const durationMs = Math.max(0, now() - started);
      if (r.skipped) {
        records.push({ ...base, status: "skipped", durationMs, error: r.reason });
      } else {
        total += r.cost;
        records.push({ ...base, status: "ok", scoreNormalised: r.score, durationMs, costUsd: r.cost, runId: r.runId });
      }
    } catch (e) {
      records.push({
        ...base,
        status: "error",
        durationMs: Math.max(0, now() - started),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { suiteSlug: opts.suiteSlug, records, totalCostUsd: total, budgetExceeded: exceeded || total >= cap };
}
