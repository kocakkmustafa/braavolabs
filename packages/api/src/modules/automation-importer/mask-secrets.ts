/**
 * Secret masking for imported automation payloads.
 *
 * DECISION (Açık Soru #2, BINDING; findings B9): the importer used to persist
 * the raw automation export VERBATIM in `Pipeline.config.originalPayload`. n8n
 * and MCP exports frequently embed `apiKey` / `token` / `password` /
 * `authorization` fields in plaintext — which then sat un-encrypted in the
 * `Pipeline.config` JSONB (outside the AES-256-GCM `encryptedCredentials`
 * path). This module walks the parsed payload and redacts any secret-like KEY
 * before persistence so no plaintext credential leaks into the DB.
 *
 * We match on the KEY NAME (case-insensitive, substring), not the value, so
 * the redaction is deterministic and doesn't depend on value heuristics.
 */

const SECRET_KEY_PATTERNS = [
  "apikey",
  "api_key",
  "token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "auth_token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "credential",
  "credentials",
  "bearer",
];

export const MASK = "***REDACTED***";

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Recursively deep-clone `value`, replacing any object property whose key looks
 * like a secret with a redaction marker. Non-object inputs (strings, numbers,
 * markdown payloads) are returned unchanged — there are no keyed fields to
 * redact. Bounded recursion depth guards against pathological/cyclic inputs.
 */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 64) return value;
  if (Array.isArray(value)) {
    return value.map((v) => maskSecrets(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = MASK;
      } else {
        out[k] = maskSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
