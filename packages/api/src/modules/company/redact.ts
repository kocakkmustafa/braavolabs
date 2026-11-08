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

// Key-name classifier. The name is split into lowercase parts (camelCase,
// ACRONYMCase, snake_case, kebab-case, spaces, dots), so harmless names that
// merely contain "key"/"token" as a substring (keywords, keyMessages, monkey,
// tokenizer_model) are NOT matched, while compounds are (apiKey, x-api-key,
// private_key, accessToken, SESSION_ID). When a name is ambiguous the safe
// direction is to redact (e.g. maxTokens is masked).
const SECRET_SUFFIXES = [
  "secret", "token", "password", "passwd", "credential", "authorization", "bearer", "cookie",
  "dsn", "apikey", "privatekey", "signingkey", "accesskey", "secretkey", "encryptionkey",
  "masterkey", "sessionid", "sessiontoken",
];
const SECRET_EXACT = new Set(["auth", "oauth", "jwt", "pwd", "key", "session"]);
const KEY_PREFIXES = new Set([
  "api", "private", "signing", "access", "secret", "encryption", "master", "client", "auth", "license", "webhook", "x",
]);

function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

const singular = (p: string) => (p.length > 3 && p.endsWith("s") && !p.endsWith("ss") ? p.slice(0, -1) : p);

export function isSecretKeyName(name: string): boolean {
  const parts = nameParts(name).map(singular);
  if (parts.length === 0) return false;
  // Whole name is exactly one of the ambiguous bare words ("key", "session", "auth", ...).
  if (parts.length === 1 && SECRET_EXACT.has(parts[0]!)) return true;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "auth" || p === "oauth" || p === "jwt" || p === "pwd") return true;
    if (SECRET_SUFFIXES.some((suf) => p.endsWith(suf))) return true;
    // "<prefix> key" pairs: api key, private key, x api key, ...
    if (p === "key" && i > 0 && KEY_PREFIXES.has(parts[i - 1]!)) return true;
    if (p === "session" && (parts[i + 1] === "id" || parts[i + 1] === "token" || parts[i + 1] === "cookie")) return true;
  }
  return false;
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
