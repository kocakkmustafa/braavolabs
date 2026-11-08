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
 *   2. Defence in depth: inside surviving values, any object key that
 *      isSecretKeyName() flags (part-wise match, nested objects and arrays
 *      included) is replaced with REDACTED.
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

// Key-name classifier, fail-closed. The name is lowercased and stripped of
// separators; if it contains any secret-ish substring it is a secret, unless
// the normalized name is one of the few known harmless config fields below.
// `key` is matched part-wise (camelCase/snake/kebab split): any part that is
// or ends with "key"/"keys" counts (stripeKey, openaiKey, x-api-key, monkey).
// When a name is ambiguous the safe direction is to redact (maxTokens,
// authority, sessions_per_day are masked on purpose).
const SECRET_SUBSTRINGS = [
  "secret", "token", "passw", "pwd", "credential", "bearer", "cookie", "jwt", "dsn", "auth", "session",
];

// Exact (normalized) names that contain a secret-ish substring but are known
// harmless. Keep this list SHORT; each entry needs a reason:
//   keywords / keyword / keymessages  marketing copy fields (icp, brand voice)
//   tokenizer / tokenizermodel        model metadata, not a credential
//   author / authors                  content attribution
//   monkey                            plain word ending in "key"
const HARMLESS_NAMES: ReadonlySet<string> = new Set([
  "keywords", "keyword", "keymessages", "tokenizer", "tokenizermodel", "author", "authors", "monkey",
]);

function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

export function isSecretKeyName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length === 0) return false;
  if (HARMLESS_NAMES.has(normalized)) return false;
  if (SECRET_SUBSTRINGS.some((sub) => normalized.includes(sub))) return true;
  return nameParts(name).some((p) => p.endsWith("key") || p.endsWith("keys"));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 20) return REDACTED; // pathological nesting: fail closed
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKeyName(k) ? REDACTED : redactValue(v, depth + 1);
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
    if (PUBLIC_CONFIG_KEYS.has(k) && !isSecretKeyName(k)) out[k] = redactValue(v, 0);
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
