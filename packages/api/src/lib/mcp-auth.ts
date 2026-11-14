/**
 * Connector auth material: header mapping + the list of secret strings that
 * must never leave the process (SEC-BRA-06b). Kept free of I/O so it can be
 * shared by the MCP client and the dynamic-tool wrapper.
 */

export function authHeaders(method: string, creds: Record<string, string> | undefined): Record<string, string> {
  if (!creds) return {};
  switch (method) {
    case "NONE":
      return {};
    case "API_KEY":
      // Accept either standard header keys or a tenant-supplied
      // override (header name is encoded into the connector's
      // authSchema).
      if (creds.headerName && creds.apiKey) return { [creds.headerName]: creds.apiKey };
      if (creds.apiKey) return { Authorization: `Bearer ${creds.apiKey}` };
      return {};
    case "BASIC":
      if (creds.username && creds.password) {
        const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
        return { Authorization: `Basic ${token}` };
      }
      return {};
    case "OAUTH2":
      // OAuth2 access tokens are short-lived; we expect the install
      // flow to refresh them before storing. Long-term refresh is
      // a follow-up — out of scope for the MVP marketplace.
      if (creds.accessToken) return { Authorization: `Bearer ${creds.accessToken}` };
      return {};
    case "CUSTOM":
      // Custom auth: caller pre-formats headers into `headers` JSON.
      try {
        // Must be a plain object of string values; "null", arrays, scalars
        // and malformed JSON all count as "no headers".
        const parsed: unknown = creds.headers ? JSON.parse(creds.headers) : {};
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
        return out;
      } catch {
        return {};
      }
    default:
      return {};
  }
}

/** Values shorter than this are not masked (a 1-5 char value would mangle unrelated text). */
const MIN_SCRUB_LEN = 6;
export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 50;
/** Only these exact standard header names are exempt from masking; every other CUSTOM header value is treated as credential material. */
const NON_SECRET_HEADER = /^(content-type|content-length|accept|user-agent)$/i;

/**
 * Every string that could echo the credential: raw creds, the header values
 * actually sent (Basic base64 token, Bearer token, each CUSTOM header value),
 * the token part after the auth scheme, each trimmed, plus base64 and
 * URL-encoded forms. Residual risk (split/chunked, hex, case-changed echoes)
 * is accepted and documented in the PR.
 */
export function credentialSecrets(authMethod: string, creds: Record<string, string> | undefined): string[] {
  if (!creds) return [];
  // Raw creds: skip `headerName` (a header NAME, not a secret) and the CUSTOM
  // `headers` JSON blob (its non-secret entries are filtered below, per header).
  const base: string[] = Object.entries(creds)
    .filter(([k, v]) => typeof v === "string" && k !== "headerName" && !(authMethod === "CUSTOM" && k === "headers"))
    .map(([, v]) => v);
  let headers: Record<string, unknown> = {};
  try {
    headers = authHeaders(authMethod, creds);
  } catch {
    /* fall through with raw creds only */
  }
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) headers = {};
  if (authMethod === "CUSTOM") {
    // authHeaders drops non-string values (they are never sent); still mask them if echoed.
    try {
      const parsed: unknown = creds.headers ? JSON.parse(creds.headers) : {};
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, v] of Object.entries(parsed)) {
          if (typeof v !== "string" && v != null && !NON_SECRET_HEADER.test(name)) base.push(String(v));
        }
      }
    } catch {
      /* malformed headers JSON: nothing was sent */
    }
  }
  for (const [name, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    if (NON_SECRET_HEADER.test(name)) continue;
    base.push(v);
    const m = /^(?:bearer|basic)\s+(.+)$/i.exec(v);
    if (m) base.push(m[1]);
  }
  const out = new Set<string>();
  for (const s of base) {
    for (const v of [s, s.trim()]) {
      if (!v) continue;
      out.add(v);
      out.add(Buffer.from(v).toString("base64"));
      out.add(encodeURIComponent(v));
      out.add(encodeURIComponent(Buffer.from(v).toString("base64")));
    }
  }
  return [...out].filter((v) => v.length >= MIN_SCRUB_LEN).sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of each secret in every string (values AND keys) of
 * `value`, recursively. Fail-closed: beyond MAX_DEPTH the whole subtree becomes
 * "[REDACTED]". Pure; does not mutate the input.
 */
export function scrubSecrets(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return secrets.reduce((acc, sec) => acc.split(sec).join(REDACTED), v);
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) return REDACTED;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [walk(k, depth + 1) as string, walk(x, depth + 1)]),
    );
  };
  return walk(value, 0);
}
