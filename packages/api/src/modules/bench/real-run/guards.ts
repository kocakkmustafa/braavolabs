/**
 * Cap and live-mode guards (BRA-P1-05-N3). Pure functions: no I/O, and they
 * only ever report key PRESENCE (names), never values.
 */

export const HARD_CAP_USD = 20;
export const DEFAULT_CAP_USD = 20;
/** New calls stop once real spend reaches this share of the cap. */
export const STOP_FRACTION = 0.9;
export const MAX_RETRIES = 1;

export class RealRunRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RealRunRefusal";
  }
}

/** Validate `capUsd` and return it as integer micro-USD. */
export function capToMicroUsd(capUsd: number | undefined): number {
  const cap = capUsd ?? DEFAULT_CAP_USD;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    throw new RealRunRefusal("CAP_INVALID", "capUsd must be a positive number");
  }
  if (cap > HARD_CAP_USD) {
    throw new RealRunRefusal("CAP_ABOVE_HARD_LIMIT", `capUsd above the hard limit of ${HARD_CAP_USD} USD is refused`);
  }
  return Math.round(cap * 1_000_000);
}

/** Env var names that may carry a provider key, in resolution order. */
export function keyEnvNames(provider: string): string[] {
  return [`BENCH_${provider}_KEY`, `${provider}_API_KEY`];
}

/** Which env var (name only) supplies the key, or null when absent. */
export function keyEnvName(provider: string, env: Record<string, string | undefined>): string | null {
  for (const n of keyEnvNames(provider)) {
    const v = env[n];
    if (typeof v === "string" && v.trim().length > 0) return n;
  }
  return null;
}

export interface LiveGuardInput {
  live: boolean;
  understandSpend: boolean;
  providers: string[];
  env: Record<string, string | undefined>;
}

/** Empty list = live run allowed. Reasons are constant strings (no values). */
export function liveGuardReasons(i: LiveGuardInput): string[] {
  const reasons: string[] = [];
  if (!i.live) return reasons;
  if (!i.understandSpend) reasons.push("missing flag --i-understand-spend");
  if (i.env.BENCH_REAL_RUN_APPROVED !== "1") reasons.push("env BENCH_REAL_RUN_APPROVED=1 not set");
  for (const p of i.providers) {
    if (!keyEnvName(p, i.env)) reasons.push(`no API key in env for ${p} (${keyEnvNames(p).join(" or ")})`);
  }
  return reasons;
}
