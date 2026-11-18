/**
 * Accuracy measurement wrapper (BRA-P1-05b).
 *
 * `runAccuracyBench` runs ONE fixed suite on up to MAX_CANDIDATES compare
 * candidates (ModelSelection, same type compare uses) via `runBenchSuite`,
 * sequentially so the cumulative cost ceiling can stop the remainder.
 * One record per candidate; `runBenchSuite` persists the BenchRun row
 * itself on success only (runId links to it; failed/skipped candidates
 * have no row). The runner is injectable (tests use a fake).
 *
 * Known limit: the ceiling is checked BETWEEN candidates; runBenchSuite has
 * no per-task limit, so the first candidate can exceed it on its own.
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
  /** Real cost when known; null when unknown (see costEstimated); 0 when nothing ran. */
  costUsd: number | null;
  /** True when costUsd is unknown and a conservative estimate was added to the total. */
  costEstimated: boolean;
  /** BenchRun row id when persisted. */
  runId: string | null;
  /** Sanitised, truncated; never a raw provider body. */
  error: string | null;
}

export interface AccuracyBenchResult {
  suiteSlug: string;
  records: AccuracyRecord[];
  totalCostUsd: number;
  /** True only when a candidate was skipped because the ceiling was reached. */
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

const KNOWN_PROVIDERS: readonly RunBenchOptions["provider"][] = [
  "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER",
  "DEEPSEEK", "KIMI", "QWEN", "OLLAMA", "LMSTUDIO",
];
const asKnownProvider = (p: string): RunBenchOptions["provider"] | null =>
  KNOWN_PROVIDERS.find((k) => k === p) ?? null;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Single-line and bounded; the runner's raw message may embed provider bodies. */
function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return `run failed: ${raw.replace(/[\r\n]+/g, " ").slice(0, 200)}`;
}

export async function runAccuracyBench(opts: AccuracyBenchOptions): Promise<AccuracyBenchResult> {
  if (!nonEmpty(opts.suiteSlug)) throw new Error("suiteSlug is required");
  if (!Array.isArray(opts.candidates) || opts.candidates.length === 0) {
    throw new Error("At least one candidate is required");
  }
  if (opts.candidates.length > MAX_CANDIDATES) throw new Error(`At most ${MAX_CANDIDATES} candidates are allowed`);
  const seen = new Set<string>();
  for (const c of opts.candidates) {
    if (!nonEmpty(c?.provider) || !nonEmpty(c?.model)) throw new Error("Candidate provider and model are required");
    const key = `${c.provider}\u0000${c.model}`;
    if (seen.has(key)) throw new Error(`Duplicate candidate ${c.provider}/${c.model}`);
    seen.add(key);
  }

  const runner = opts.runner ?? runBenchSuite;
  const now = opts.now ?? Date.now;
  const cap =
    typeof opts.maxCostUsd === "number" && Number.isFinite(opts.maxCostUsd) ? opts.maxCostUsd : DEFAULT_MAX_COST_USD;
  // Real cost of a failed/garbled run is unknown; charge a conservative
  // upper estimate so a run of failures still trips the ceiling.
  const estimate = cap / MAX_CANDIDATES;

  const records: AccuracyRecord[] = [];
  let total = 0;
  let exceeded = false;

  for (const c of opts.candidates) {
    const base = {
      provider: c.provider, model: c.model, scoreNormalised: null, durationMs: 0,
      costUsd: 0, costEstimated: false, runId: null, error: null,
    };
    if (total >= cap) {
      exceeded = true;
      records.push({ ...base, status: "budget_skipped" });
      continue;
    }
    const provider = asKnownProvider(c.provider);
    if (!provider) {
      records.push({ ...base, status: "skipped", error: "provider not configured" });
      continue;
    }
    const started = now();
    try {
      const r = await runner({ suiteSlug: opts.suiteSlug, provider, model: c.model, notes: opts.notes });
      const durationMs = Math.max(0, now() - started);
      if (r.skipped) {
        records.push({ ...base, status: "skipped", durationMs, error: "provider not configured" });
      } else {
        const costKnown = Number.isFinite(r.cost) && r.cost >= 0;
        total += costKnown ? r.cost : estimate;
        const score = Number.isFinite(r.score) ? Math.min(1, Math.max(0, r.score)) : 0;
        records.push({
          ...base, status: "ok", scoreNormalised: score, durationMs,
          costUsd: costKnown ? r.cost : null, costEstimated: !costKnown, runId: r.runId,
        });
      }
    } catch (e) {
      total += estimate;
      records.push({
        ...base, status: "error", durationMs: Math.max(0, now() - started),
        costUsd: null, costEstimated: true, error: safeError(e),
      });
    }
  }
  return { suiteSlug: opts.suiteSlug, records, totalCostUsd: total, budgetExceeded: exceeded };
}
