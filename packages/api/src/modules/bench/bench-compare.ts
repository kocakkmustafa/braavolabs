/**
 * Bench compare wiring (BRA-P1-05-N1): fixed bench set x 2-3 models ->
 * per-model accuracy / cost / latency + `summarizeCompareMetrics` summary.
 *
 * Provider is a DETERMINISTIC FAKE (no network, no keys, no DB, no clock):
 * scores, costs and latencies derive from a hash of provider/model/suite and
 * the latency is read from a virtual clock the fake advances. Nothing is
 * persisted (BenchRun has no tenant column), so there is no tenant data to
 * leak; the response carries only measurements, never prompts, keys or URLs.
 * Fake behaviours (for failure-path coverage): model names starting with
 * `fake-error` fail, `fake-timeout` never settles (cut by the timeout),
 * `fake-skip` reports the provider as not configured.
 */
import { runAccuracyBench, type AccuracyRecord } from "./bench-accuracy";
import type { RunBenchOptions, RunBenchResult } from "./bench.service";
import { summarizeCompareMetrics, type CompareMetrics } from "../../services/compare-metrics";
import type { ModelSelection } from "../../services/multi-model";
import { BUILTIN_SUITES } from "./suites";

export const BENCH_COMPARE_SUITE_SLUGS = BUILTIN_SUITES.map((s) => s.slug);
export const DEFAULT_COMPARE_TIMEOUT_MS = 5_000;
export const DEFAULT_COMPARE_MAX_COST_USD = 0.25;

/** FNV-1a, deterministic across runs and platforms. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface BenchCompareResponse {
  suite: string;
  provider: "fake";
  candidates: Array<{
    provider: string;
    model: string;
    status: AccuracyRecord["status"];
    scoreNormalised: number | null;
    durationMs: number | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
  metrics: CompareMetrics;
  totalCostUsd: number;
  budgetExceeded: boolean;
}

const STATUS_REASON: Record<Exclude<AccuracyRecord["status"], "ok">, string> = {
  error: "run failed",
  skipped: "skipped",
  budget_skipped: "skipped: budget",
};

export async function runBenchCompare(opts: {
  suiteSlug: string;
  candidates: ModelSelection[];
  maxCostUsd?: number;
  timeoutMs?: number;
}): Promise<BenchCompareResponse> {
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_COMPARE_MAX_COST_USD;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPARE_TIMEOUT_MS;
  let virtualNow = 0;
  const tokensByModel = new Map<string, { input: number; output: number }>();
  const key = (p: string, m: string) => `${p}\u0000${m}`;

  const fake = async (o: RunBenchOptions): Promise<RunBenchResult> => {
    if (o.model.startsWith("fake-skip")) return { skipped: true, provider: o.provider, model: o.model, reason: "skipped" };
    if (o.model.startsWith("fake-error")) throw new Error("fake provider error");
    if (o.model.startsWith("fake-timeout")) return new Promise<RunBenchResult>(() => undefined);
    const h = hash(`${o.suiteSlug}|${o.provider}|${o.model}`);
    const input = 200 + (h % 400);
    const output = 100 + ((h >>> 8) % 300);
    tokensByModel.set(key(o.provider, o.model), { input, output });
    virtualNow += 120 + ((h >>> 4) % 900);
    return {
      skipped: false,
      runId: `fake-${h.toString(16)}`,
      score: ((h >>> 12) % 1001) / 1000,
      cost: Number(((input + output) * 0.00002).toFixed(6)),
    };
  };

  const guarded = async (o: RunBenchOptions): Promise<RunBenchResult> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fake(o),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            virtualNow += timeoutMs;
            reject(new Error("timeout"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const result = await runAccuracyBench({
    suiteSlug: opts.suiteSlug,
    candidates: opts.candidates,
    maxCostUsd,
    runner: guarded,
    now: () => virtualNow,
  });

  const perModel = result.records.filter((r) => r.status === "ok").map((r) => ({
    provider: r.provider as never,
    model: r.model,
    answer: "",
    tokens: tokensByModel.get(key(r.provider, r.model)) ?? { input: 0, output: 0 },
    costUsd: r.costUsd ?? 0,
    durationMs: r.durationMs,
  }));
  const failed = result.records.filter((r) => r.status !== "ok").map((r) => ({
    provider: r.provider as never,
    model: r.model,
    error: STATUS_REASON[r.status as Exclude<AccuracyRecord["status"], "ok">],
  }));
  const metrics = summarizeCompareMetrics(
    { perModel, failed, synthesizer: null, totalCostUsd: result.totalCostUsd, budgetExceeded: result.budgetExceeded },
    { maxCostUsd },
  );

  return {
    suite: result.suiteSlug,
    provider: "fake",
    candidates: result.records.map((r) => {
      const t = tokensByModel.get(key(r.provider, r.model));
      const ok = r.status === "ok";
      return {
        provider: r.provider,
        model: r.model,
        status: r.status,
        scoreNormalised: r.scoreNormalised,
        durationMs: ok ? r.durationMs : null,
        costUsd: ok ? r.costUsd : null,
        inputTokens: ok ? (t?.input ?? null) : null,
        outputTokens: ok ? (t?.output ?? null) : null,
      };
    }),
    metrics,
    totalCostUsd: result.totalCostUsd,
    budgetExceeded: result.budgetExceeded,
  };
}
