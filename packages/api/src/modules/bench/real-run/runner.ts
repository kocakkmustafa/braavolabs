/**
 * Real-run runner (BRA-P1-05-N3). Provider-agnostic: the provider call is
 * INJECTED (`ProviderCall`), so this module has no network, key or DB access.
 *
 * Cost safety: (1) worst-case pre-estimate over the whole run; above the cap
 * the run does not start (ABORT_ESTIMATE_OVER_CAP). (2) real usage from the
 * provider response accumulates; once spend reaches 90% of the cap, or the
 * next call's worst case would cross the cap, no new call starts
 * (STOPPED_AT_CAP, partial report). (3) at most one wrapper retry per task;
 * a failed attempt is charged its worst case (real usage unknown). (4)
 * ai-client retries internally (up to PROVIDER_RETRY_FACTOR wire calls per
 * attempt): the pre-estimate and the per-call guard use that multiplier.
 * (5) usage that is missing / 0+0 / NaN / negative is never counted as zero:
 * the single-attempt worst case is charged and flagged `costEstimated`;
 * CONSERVATIVE_COST_PROVIDERS (Google thinking tokens) always get
 * max(reported, worst). (6) tasks run round-robin across targets, one call at
 * a time, so a cap stop cannot favour one provider.
 * All money is integer micro-USD.
 */
import { REAL_RUN_SET_HASH, REAL_RUN_SET_VERSION, REAL_RUN_TASKS, type RealRunTask } from "./set";
import {
  CONSERVATIVE_COST_PROVIDERS,
  PRICES_VERIFIED_BY_FOUNDER,
  PRICE_WARNING,
  REAL_RUN_PRICES,
  costMicroUsd,
  estimateTokens,
  priceFor,
  worstCaseMicroUsd,
  type RealRunPrice,
} from "./pricing";
import { MAX_RETRIES, PROVIDER_RETRY_FACTOR, RealRunRefusal, STOP_FRACTION, capToMicroUsd } from "./guards";
import { SCORING_VERSION, scoreAnswer } from "./scoring";

export interface ProviderRequest {
  taskId: string;
  provider: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}
export interface ProviderResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}
export type ProviderCall = (req: ProviderRequest) => Promise<ProviderResponse>;

export interface Target {
  provider: string;
  model: string;
}

export type RunStatus = "COMPLETED" | "STOPPED_AT_CAP" | "ABORT_ESTIMATE_OVER_CAP";
export type TaskStatus = "ok" | "error" | "not_run";

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  score: number | null;
  costMicroUsd: number;
  /** True when the cost is a worst-case charge, not real provider usage. */
  costEstimated: boolean;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: number;
  /** Constant code only; never a raw provider message. */
  errorCode: string | null;
}

export interface TargetReport {
  provider: string;
  model: string;
  priceAsOf: string | null;
  priceSource: string | null;
  tasks: TaskRecord[];
  totalScore: number;
  meanScore: number | null;
  totalCostMicroUsd: number;
  meanLatencyMs: number | null;
}

export interface RealRunReport {
  schemaVersion: 1;
  mode: "dry-run" | "live";
  setVersion: string;
  setHash: string;
  scoringVersion: string;
  maxRetries: number;
  providerRetryFactor: number;
  warnings: string[];
  taskCount: number;
  capMicroUsd: number;
  estimate: { totalMicroUsd: number; perTargetMicroUsd: Record<string, number> };
  status: RunStatus;
  spentMicroUsd: number;
  targets: TargetReport[];
}

export interface RunnerOptions {
  mode: "dry-run" | "live";
  targets: Target[];
  call: ProviderCall;
  now: () => number;
  capUsd?: number;
  tasks?: readonly RealRunTask[];
  prices?: Record<string, RealRunPrice>;
  setHash?: string;
}

export function estimateRun(
  tasks: readonly RealRunTask[],
  targets: Target[],
  prices: Record<string, RealRunPrice> = REAL_RUN_PRICES,
): { totalMicroUsd: number; perTargetMicroUsd: Record<string, number> } {
  const perTarget: Record<string, number> = {};
  let total = 0;
  for (const t of targets) {
    const price = priceFor(t.provider, t.model, prices);
    if (!price) throw new RealRunRefusal("UNPRICED_MODEL", `no price entry for ${t.provider}/${t.model} in pricing.ts`);
    let sum = 0;
    for (const task of tasks) {
      const input = estimateTokens(task.system) + estimateTokens(task.prompt);
      sum += worstCaseMicroUsd(input, task.maxTokens, price) * PROVIDER_RETRY_FACTOR * (1 + MAX_RETRIES);
    }
    perTarget[`${t.provider}/${t.model}`] = sum;
    total += sum;
  }
  return { totalMicroUsd: total, perTargetMicroUsd: perTarget };
}

const notRun = (taskId: string): TaskRecord => ({
  taskId, status: "not_run", score: null, costMicroUsd: 0, costEstimated: false,
  latencyMs: null, inputTokens: null, outputTokens: null, attempts: 0, errorCode: null,
});

function summarise(t: Target, tasks: TaskRecord[], prices: Record<string, RealRunPrice>): TargetReport {
  const price = priceFor(t.provider, t.model, prices);
  const ok = tasks.filter((r) => r.status === "ok");
  const totalScore = Math.round(ok.reduce((a, r) => a + (r.score ?? 0), 0) * 1e6) / 1e6;
  const lat = ok.map((r) => r.latencyMs ?? 0);
  return {
    provider: t.provider,
    model: t.model,
    priceAsOf: price?.asOf ?? null,
    priceSource: price?.source ?? null,
    tasks,
    totalScore,
    meanScore: ok.length ? Math.round((totalScore / ok.length) * 1e6) / 1e6 : null,
    totalCostMicroUsd: tasks.reduce((a, r) => a + r.costMicroUsd, 0),
    meanLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
  };
}

export async function runRealRun(opts: RunnerOptions): Promise<RealRunReport> {
  const tasks = opts.tasks ?? REAL_RUN_TASKS;
  const prices = opts.prices ?? REAL_RUN_PRICES;
  const capMicro = capToMicroUsd(opts.capUsd);
  const estimate = estimateRun(tasks, opts.targets, prices);
  const warnings: string[] = [];
  if (!PRICES_VERIFIED_BY_FOUNDER) warnings.push(PRICE_WARNING);
  if (opts.targets.some((t) => CONSERVATIVE_COST_PROVIDERS.has(t.provider))) {
    warnings.push("GOOGLE cost is charged as max(reported, worst case) per call (thinking tokens are not reported)");
  }
  const base = {
    schemaVersion: 1 as const,
    mode: opts.mode,
    setVersion: REAL_RUN_SET_VERSION,
    setHash: opts.setHash ?? REAL_RUN_SET_HASH,
    scoringVersion: SCORING_VERSION,
    maxRetries: MAX_RETRIES,
    providerRetryFactor: PROVIDER_RETRY_FACTOR,
    warnings,
    taskCount: tasks.length,
    capMicroUsd: capMicro,
    estimate,
  };

  if (estimate.totalMicroUsd > capMicro) {
    return {
      ...base,
      status: "ABORT_ESTIMATE_OVER_CAP",
      spentMicroUsd: 0,
      targets: opts.targets.map((t) => summarise(t, tasks.map((k) => notRun(k.id)), prices)),
    };
  }

  const stopAt = Math.floor(capMicro * STOP_FRACTION);
  let spent = 0;
  let stopped = false;
  const records = new Map<string, TaskRecord[]>();
  for (const t of opts.targets) records.set(`${t.provider}/${t.model}`, []);

  // Round-robin: for each task, every target in turn.
  for (const task of tasks) {
    const inputEst = estimateTokens(task.system) + estimateTokens(task.prompt);
    for (const target of opts.targets) {
      const list = records.get(`${target.provider}/${target.model}`) as TaskRecord[];
      if (stopped) { list.push(notRun(task.id)); continue; }
      const price = priceFor(target.provider, target.model, prices) as RealRunPrice;
      const worstOne = worstCaseMicroUsd(inputEst, task.maxTokens, price);
      // Guard value: ai-client may hit the wire up to PROVIDER_RETRY_FACTOR times per attempt.
      const worstGuard = worstOne * PROVIDER_RETRY_FACTOR;
      const conservative = CONSERVATIVE_COST_PROVIDERS.has(target.provider);
      const rec: TaskRecord = { ...notRun(task.id), status: "error", errorCode: "PROVIDER_ERROR" };
      let done = false;
      for (let attempt = 1; attempt <= 1 + MAX_RETRIES && !done; attempt++) {
        if (spent >= stopAt || spent + worstGuard > capMicro) {
          stopped = true;
          break;
        }
        rec.attempts = attempt;
        const t0 = opts.now();
        try {
          const res = await opts.call({
            taskId: task.id, provider: target.provider, model: target.model,
            system: task.system, prompt: task.prompt, maxTokens: task.maxTokens,
          });
          rec.latencyMs = Math.max(0, opts.now() - t0);
          if (!res || typeof res.content !== "string") throw new Error("invalid response");
          const reliable = Number.isFinite(res.inputTokens) && Number.isFinite(res.outputTokens) &&
            res.inputTokens >= 0 && res.outputTokens >= 0 && res.inputTokens + res.outputTokens > 0;
          let cost: number;
          if (reliable) {
            cost = costMicroUsd(res.inputTokens, res.outputTokens, price);
            rec.inputTokens = res.inputTokens;
            rec.outputTokens = res.outputTokens;
            if (conservative) {
              cost = Math.max(cost, worstOne);
              rec.costEstimated = true;
            }
          } else {
            cost = worstOne;
            rec.costEstimated = true;
          }
          spent += cost;
          rec.costMicroUsd += cost;
          rec.score = scoreAnswer(task.scorer, res.content);
          rec.status = "ok";
          rec.errorCode = null;
          done = true;
        } catch {
          rec.latencyMs = Math.max(0, opts.now() - t0);
          spent += worstGuard;
          rec.costMicroUsd += worstGuard;
          rec.costEstimated = true;
        }
      }
      list.push(stopped && rec.attempts === 0 ? notRun(task.id) : rec);
    }
  }

  const reports = opts.targets.map((t) => summarise(t, records.get(`${t.provider}/${t.model}`) as TaskRecord[], prices));
  return { ...base, status: stopped ? "STOPPED_AT_CAP" : "COMPLETED", spentMicroUsd: spent, targets: reports };
}
