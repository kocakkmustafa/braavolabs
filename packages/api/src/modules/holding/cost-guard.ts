import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";

/**
 * Cost Guard v1 (FABLE_PLAN §3, Anayasa §3) — a CODE module, not an LLM
 * agent. Single choke-point every holding run passes through before and
 * after spending.
 *
 * Caps are the Anayasa §3 table verbatim; agents cannot change them (they
 * are compile-time constants — editing this file is an R5 governance change).
 * NOTE: these guards are the in-process brake. The provider-console hard
 * caps (K2) are the out-of-process brake and MUST exist before the motor is
 * attached to any live cron (MOTOR-KICKOFF sert kural #4).
 */
export const RUN_CAP_USD = 2;
export const DAILY_SOFT_USD = 10;
export const DAILY_HARD_USD = 25;
export const RATE_WINDOW_MS = 5 * 60_000;
export const RATE_CAP_USD = 2;

const DAY_KEY = (day: string) => `holding:cost:day:${day}`;
const WINDOW_KEY = (bucket: number) => `holding:cost:win:${bucket}`;
export const FREEZE_KEY = "holding:cost:freeze";

/** Minimal Redis surface — injectable for tests. */
export interface CostRedis {
  incrbyfloat(key: string, amount: number): Promise<string | number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface CostGuardDeps {
  redis?: CostRedis;
  now?: () => number;
  /** Called when the spend-rate sensor trips (>$2/5min → SEV0). */
  onRateAlarm?: (spentUsd: number) => Promise<void>;
}

function dayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** True when the daily SOFT cap is crossed — surfaced, never blocking. */
  softAlert?: boolean;
}

/**
 * Pre-flight gate: called BEFORE a run is enqueued, with the charter's cost
 * estimate. Blocks on: global freeze, per-run cap, projected daily hard cap.
 */
export async function preflight(estUsd: number, deps: CostGuardDeps = {}): Promise<PreflightResult> {
  const r = deps.redis ?? (redis as unknown as CostRedis);
  const now = deps.now?.() ?? Date.now();

  if (!Number.isFinite(estUsd) || estUsd < 0) {
    return { ok: false, reason: "invalid cost estimate — fail-closed" };
  }
  if ((await r.get(FREEZE_KEY)) !== null) {
    return { ok: false, reason: "holding spend is FROZEN — founder reset required" };
  }
  if (estUsd > RUN_CAP_USD) {
    return { ok: false, reason: `estimate $${estUsd} exceeds run cap $${RUN_CAP_USD}` };
  }
  const spentToday = parseFloat((await r.get(DAY_KEY(dayOf(now)))) ?? "0");
  if (spentToday + estUsd > DAILY_HARD_USD) {
    return { ok: false, reason: `daily hard cap $${DAILY_HARD_USD} would be exceeded (spent $${spentToday.toFixed(2)})` };
  }
  return { ok: true, softAlert: spentToday + estUsd > DAILY_SOFT_USD };
}

/**
 * Record actual spend AFTER the fact and run the spend-rate sensor.
 * The rate sensor is the runaway-loop brake: cumulative daily counters are
 * too slow ("runaway loop dakikalarda yakar"), so a 5-minute bucket trips a
 * freeze + SEV0 immediately.
 */
export async function recordSpend(usd: number, deps: CostGuardDeps = {}): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const r = deps.redis ?? (redis as unknown as CostRedis);
  const now = deps.now?.() ?? Date.now();

  const dayKey = DAY_KEY(dayOf(now));
  await r.incrbyfloat(dayKey, usd);
  await r.expire(dayKey, 3 * 24 * 3600);

  const bucket = Math.floor(now / RATE_WINDOW_MS);
  const winKey = WINDOW_KEY(bucket);
  const inWindow = parseFloat(String(await r.incrbyfloat(winKey, usd)));
  await r.expire(winKey, Math.ceil((2 * RATE_WINDOW_MS) / 1000));

  if (inWindow > RATE_CAP_USD) {
    // Freeze FIRST (stop the bleed), then alarm. Aşım kendisi bir sinyaldir.
    await r.set(FREEZE_KEY, new Date(now).toISOString());
    logger.error({ inWindow }, "Holding spend-rate sensor tripped — spend FROZEN (SEV0)");
    try {
      await deps.onRateAlarm?.(inWindow);
    } catch (err) {
      logger.error({ err }, "spend-rate alarm hook failed (freeze already applied)");
    }
  }
}
