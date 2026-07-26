import { createHash } from "crypto";
import {
  RISK_CLASSES,
  type HoldingCharter,
  type HoldingRiskClassStr,
} from "./types";

/**
 * Charter K0 linter + hash (Kompanzasyon §5A).
 *
 * The charter is the single point where garbage can enter the control loop
 * (the system measures fidelity to the charter, not truth), so creation is
 * gated by this deterministic linter — no LLM involved.
 */

/** Hard cap from FABLE_PLAN §5A — keeps verbatim embedding cheap. */
export const CHARTER_TOKEN_CAP = 500;

/** Accepted source-reference shapes; anything else fails K0 resolution. */
const SOURCE_PATTERN = /^(registry:|doc:|file:|https?:\/\/)\S+/;

/**
 * "Measurable predicate" heuristic: a number, a comparator, a percentage, or
 * an explicit bound word. Deliberately a regex (K0 = script, $0) — the K1
 * rubric judge arrives in a later package.
 */
const MEASURABLE_PATTERN =
  /(\d|[<>≤≥=]|%|\b(en az|en fazla|at least|at most|all|tümü|hepsi|sıfır|zero)\b)/i;

/** ~4 chars/token — same coarse estimate the cost guard uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CharterLintResult {
  ok: boolean;
  errors: string[];
}

export function lintCharter(charter: unknown): CharterLintResult {
  const errors: string[] = [];
  if (typeof charter !== "object" || charter === null || Array.isArray(charter)) {
    return { ok: false, errors: ["charter must be an object"] };
  }
  const c = charter as Partial<HoldingCharter>;

  if (typeof c.goal !== "string" || c.goal.trim().length === 0) {
    errors.push("goal: required non-empty string");
  }

  if (!Array.isArray(c.successCriteria) || c.successCriteria.length === 0) {
    errors.push("successCriteria: required non-empty array");
  } else if (!c.successCriteria.some((s) => typeof s === "string" && MEASURABLE_PATTERN.test(s))) {
    errors.push("successCriteria: at least one criterion must be measurable (number/comparator/bound)");
  }

  if (!Array.isArray(c.constraints)) {
    errors.push("constraints: required array (may be empty)");
  }

  if (!RISK_CLASSES.includes(c.riskClass as HoldingRiskClassStr)) {
    errors.push("riskClass: must be one of R0-R5");
  }

  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    errors.push("sources: required non-empty array");
  } else {
    for (const s of c.sources) {
      if (typeof s !== "string" || !SOURCE_PATTERN.test(s)) {
        errors.push(`sources: unresolvable reference ${JSON.stringify(s)} (expected registry:/doc:/file:/http(s) prefix)`);
      }
    }
  }

  if (c.estCostUsd !== undefined && (typeof c.estCostUsd !== "number" || c.estCostUsd < 0 || !Number.isFinite(c.estCostUsd))) {
    errors.push("estCostUsd: must be a non-negative finite number when present");
  }

  if (errors.length === 0) {
    const tokens = estimateTokens(canonicalJson(c));
    if (tokens > CHARTER_TOKEN_CAP) {
      errors.push(`charter too large: ~${tokens} tokens > cap ${CHARTER_TOKEN_CAP}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Recursively key-sorted JSON so the hash is independent of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function charterHash(charter: HoldingCharter): string {
  return createHash("sha256").update(canonicalJson(charter)).digest("hex");
}
