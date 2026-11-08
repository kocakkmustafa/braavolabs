/**
 * BRA-SEC-01 — response-side redaction for `Company.config` (Json).
 *
 * `Company.config` holds a mix of user-managed settings and server-written
 * secrets (e.g. `webhookSecret`, written in plaintext by the webhook template
 * install and read by the inbound HMAC check). Every verified member of a
 * tenant could read it through GET /companies, GET /companies/:id, GET
 * /runs/:id (pipeline.company), GET /pipelines/:id (company) and the export
 * bundles. This module is the single choke point for what leaves the API.
 *
 * Contract (locked by redact.test.ts):
 *   1. Allowlist: only the keys in PUBLIC_CONFIG_KEYS survive at the top
 *      level; unknown keys are dropped (new server-written keys are private
 *      by default).
 *   2. Defence in depth: inside surviving values, any object key matching
 *      SECRET_KEY_RE (case-insensitive, nested objects and arrays included)
 *      is replaced with REDACTED.
 *   3. If a secret-named key exists at the top level (webhookSecret), it is
 *      never echoed; `webhookSecretSet: true` reports that one is configured.
 *   4. null / undefined / non-object config → `{}` (never throws).
 *   5. Pure: the input is not mutated. Webhook HMAC verification keeps
 *      reading the raw DB row and must never go through this module.
 */

export const REDACTED = "***";

/** Keys the UI / API clients may see. Mirrors USER_WRITABLE_CONFIG_KEYS in
 *  company/router.ts plus the benign keys written by server code paths
 *  (starter template, onboarding hero company). */
export const PUBLIC_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "niche",
  "targetAudience",
  "channels",
  "companyType",
  "brand_voice",
  "icp",
  "kpi",
  "budget",
  "work_mode",
  "use_cases",
  "startedFromTemplate",
  "templateOutcome",
  "postingFrequency",
]);

const SECRET_KEY_RE = /secret|token|key|password|credential/i;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 20) return REDACTED; // pathological nesting: fail closed
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactCompanyConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const raw = config as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (PUBLIC_CONFIG_KEYS.has(k) && !SECRET_KEY_RE.test(k)) out[k] = redactValue(v, 0);
  }
  const secret = raw.webhookSecret;
  if (typeof secret === "string" && secret.length > 0) out.webhookSecretSet = true;
  return out;
}

/** Return a copy of a Company row (any extra relations preserved) that is safe
 *  to send to a client. Leaves rows without a `config` key unchanged in shape. */
export function toPublicCompany<T extends object>(company: T): T;
export function toPublicCompany<T extends object>(company: T | null | undefined): T | null | undefined;
export function toPublicCompany<T extends object>(company: T | null | undefined): T | null | undefined {
  if (!company) return company;
  if (!("config" in company)) return company;
  return { ...company, config: redactCompanyConfig((company as { config?: unknown }).config) };
}
