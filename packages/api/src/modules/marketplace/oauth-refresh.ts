/**
 * BRA-P1-02a: OAuth2 access-token refresh for connector credentials.
 *
 * The credential JSON (AES-GCM encrypted at rest) may carry `refreshToken`,
 * `expiresAt` (epoch ms), `tokenUrl` and optionally `clientId`/`clientSecret`.
 * Credentials without a `refreshToken` (or without `expiresAt`) are returned
 * untouched, so existing connectors behave exactly as before.
 *
 * Failure policy: if a refresh is due and fails, the call is refused; the
 * stale token is never sent upstream. Errors are fixed strings and never
 * include token material or the upstream response body.
 */

import { prisma } from "../../lib/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { logger } from "../../lib/logger";
import { safeExternalFetch } from "../../lib/ssrf";
import { connectorAad } from "./connector-lifecycle";

/** Refresh slightly early so a token does not expire mid-flight. */
export const REFRESH_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;
/** Provider-supplied lifetime is clamped: non-finite or <=0 -> 1h, never above 24h. */
const DEFAULT_EXPIRES_IN_S = 3600;
const MAX_EXPIRES_IN_S = 24 * 3600;
const TOKEN_MAX_BYTES = 64 * 1024;
/** Failed refreshes are remembered per connector so repeated calls do not hammer the token endpoint. */
const NEGATIVE_TTL_MS = 30_000;
const WRITE_RETRY_DELAY_MS = 50;

export class OAuthRefreshError extends Error {
  constructor(message = "OAuth token yenilenemedi") {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

interface RefreshInstall {
  id: string;
  connector: { id: string; slug?: string; authMethod: string; mcpServerUrl: string };
}

const inflight = new Map<string, Promise<Record<string, string>>>();
const failedUntil = new Map<string, number>();

/** Test hook: clears process-local state. */
export function __resetOAuthRefreshState(): void {
  inflight.clear();
  failedUntil.clear();
}

export function needsRefresh(authMethod: string, creds: Record<string, string>, now = Date.now()): boolean {
  if (authMethod !== "OAUTH2" || !creds.refreshToken || !creds.expiresAt) return false;
  const exp = Number(creds.expiresAt);
  // An unparseable expiry on a refreshable credential is treated as expired (fail closed).
  return !Number.isFinite(exp) || exp - REFRESH_SKEW_MS <= now;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Multi-part public suffixes and shared-hosting suffixes (small built-in list,
 * no dependency). A suffix here is never a registrable domain itself:
 * `a.co.uk` and `b.co.uk` (or `a.github.io` and `b.github.io`) are different
 * sites. Single-label TLDs (com, io, example ...) are handled implicitly.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.tr", "org.tr", "net.tr", "gen.tr",
  "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "co.in", "com.br", "com.cn", "co.nz", "co.za", "com.mx", "com.sg", "com.hk",
  // shared hosting: every customer gets a subdomain of these
  "github.io", "vercel.app", "netlify.app", "herokuapp.com", "azurewebsites.net",
  "cloudfront.net", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "appspot.com", "onrender.com", "fly.dev", "ngrok.io",
]);

function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url);
    let h = u.hostname.toLowerCase();
    while (h.endsWith(".")) h = h.slice(0, -1);
    return h || null;
  } catch {
    return null;
  }
}

function isIpHost(h: string): boolean {
  return h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

/** Registrable domain (eTLD+1) of a hostname, or null when the host is itself a suffix / has no registrable part. */
function registrableDomain(host: string): string | null {
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (let n = Math.min(labels.length, 3); n >= 2; n--) {
    if (MULTI_PART_SUFFIXES.has(labels.slice(-n).join("."))) {
      return labels.length > n ? labels.slice(-(n + 1)).join(".") : null;
    }
  }
  return labels.slice(-2).join(".");
}

/**
 * Credential-leak guard: the token endpoint must be the connector's registered
 * domain (eTLD+1) or a subdomain of it. Hostname only; port/path ignored.
 * IPs and single-label hosts require exact equality. Fails closed on bad URLs.
 */
export function isTokenUrlSameSite(tokenUrl: string, mcpServerUrl: string): boolean {
  const t = hostnameOf(tokenUrl);
  const m = hostnameOf(mcpServerUrl);
  if (!t || !m) return false;
  if (t === m) return true;
  if (isIpHost(t) || isIpHost(m)) return false;
  const reg = registrableDomain(m);
  if (!reg) return false;
  return t === reg || t.endsWith("." + reg);
}

async function doRefresh(
  tenantId: string,
  install: RefreshInstall,
  creds: Record<string, string>,
): Promise<Record<string, string>> {
  // Re-read the row: a refresh that finished after our caller read the
  // credentials must not be repeated with a stale (possibly rotated-away)
  // refresh token. Revoked/disabled rows are refused here too.
  const aad = connectorAad(tenantId, install.connector.id);
  const row = await prisma.tenantConnector.findFirst({
    where: { id: install.id, tenantId, revokedAt: null, isEnabled: true },
    select: { encryptedCredentials: true },
  });
  if (!row) throw new OAuthRefreshError();
  const readValue = row.encryptedCredentials;
  try {
    creds = JSON.parse(decrypt(readValue, aad));
  } catch {
    throw new OAuthRefreshError();
  }
  if (!needsRefresh(install.connector.authMethod, creds)) return creds;

  const { tokenUrl } = creds;
  if (!tokenUrl || !isHttps(tokenUrl) || !isHttps(install.connector.mcpServerUrl)) {
    throw new OAuthRefreshError("OAuth token yenilenemedi: HTTPS gerekli");
  }
  // Fail closed before any fetch: refresh token / clientSecret must not leave the connector's domain.
  if (!isTokenUrlSameSite(tokenUrl, install.connector.mcpServerUrl)) {
    throw new OAuthRefreshError("OAuth token yenilenemedi: tokenUrl bağlayıcı alanıyla eşleşmiyor");
  }
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refreshToken! });
  if (creds.clientId) form.set("client_id", creds.clientId);
  if (creds.clientSecret) form.set("client_secret", creds.clientSecret);

  let json: unknown;
  try {
    const res = await safeExternalFetch(
      tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      },
      { requireHttps: true, maxRedirects: 0, maxResponseBytes: TOKEN_MAX_BYTES },
    );
    if (!res.ok) throw new OAuthRefreshError();
    json = await res.json();
  } catch (err) {
    if (err instanceof OAuthRefreshError) throw err;
    throw new OAuthRefreshError();
  }
  const body = json as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.access_token !== "string" || !body.access_token) {
    throw new OAuthRefreshError();
  }
  const rawExp = body.expires_in;
  const expiresIn =
    typeof rawExp === "number" && Number.isFinite(rawExp) && rawExp > 0
      ? Math.min(rawExp, MAX_EXPIRES_IN_S)
      : DEFAULT_EXPIRES_IN_S;
  const next: Record<string, string> = {
    ...creds,
    accessToken: body.access_token,
    expiresAt: String(Date.now() + expiresIn * 1000),
  };
  // Providers that rotate refresh tokens return a new one; otherwise keep the old.
  if (typeof body.refresh_token === "string" && body.refresh_token) next.refreshToken = body.refresh_token;

  // Compare-and-swap on the value we read: a concurrent revoke/disable (or
  // another writer) makes count 0 and the revoked credential is never revived.
  const encrypted = encrypt(JSON.stringify(next), aad);
  const write = () =>
    prisma.tenantConnector.updateMany({
      where: { id: install.id, tenantId, revokedAt: null, isEnabled: true, encryptedCredentials: readValue },
      data: { encryptedCredentials: encrypted },
    });
  let count: number;
  try {
    ({ count } = await write());
  } catch {
    await new Promise((r) => setTimeout(r, WRITE_RETRY_DELAY_MS));
    try {
      ({ count } = await write());
    } catch {
      // A rotated refresh token would be lost: refuse (no token in the log).
      logger.warn({ slug: install.connector.slug ?? null }, "rotation write failed");
      throw new OAuthRefreshError();
    }
  }
  if (count === 0) throw new OAuthRefreshError();
  return next;
}

/** Returns fresh credentials (refreshing at most once per connector at a time) or throws OAuthRefreshError. */
export function ensureFreshCredentials(
  tenantId: string,
  install: RefreshInstall,
  creds: Record<string, string>,
): Promise<Record<string, string>> {
  if (!needsRefresh(install.connector.authMethod, creds)) return Promise.resolve(creds);
  const until = failedUntil.get(install.id);
  if (until && until > Date.now()) return Promise.reject(new OAuthRefreshError());
  const existing = inflight.get(install.id);
  if (existing) return existing;
  const p = doRefresh(tenantId, install, creds)
    .then((fresh) => {
      failedUntil.delete(install.id);
      return fresh;
    })
    .catch((err) => {
      failedUntil.set(install.id, Date.now() + NEGATIVE_TTL_MS);
      throw err;
    })
    .finally(() => inflight.delete(install.id));
  inflight.set(install.id, p);
  return p;
}
