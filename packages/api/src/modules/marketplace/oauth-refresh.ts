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
import { encrypt } from "../../lib/encryption";
import { safeExternalFetch } from "../../lib/ssrf";

/** Refresh slightly early so a token does not expire mid-flight. */
export const REFRESH_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_BYTES = 64 * 1024;

export class OAuthRefreshError extends Error {
  constructor(message = "OAuth token yenilenemedi") {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

interface RefreshInstall {
  id: string;
  connector: { id: string; authMethod: string; mcpServerUrl: string };
}

const inflight = new Map<string, Promise<Record<string, string>>>();

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

async function doRefresh(
  tenantId: string,
  install: RefreshInstall,
  creds: Record<string, string>,
): Promise<Record<string, string>> {
  const { tokenUrl } = creds;
  if (!tokenUrl || !isHttps(tokenUrl) || !isHttps(install.connector.mcpServerUrl)) {
    throw new OAuthRefreshError("OAuth token yenilenemedi: HTTPS gerekli");
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
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  const next: Record<string, string> = {
    ...creds,
    accessToken: body.access_token,
    expiresAt: String(Date.now() + expiresIn * 1000),
  };
  // Providers that rotate refresh tokens return a new one; otherwise keep the old.
  if (typeof body.refresh_token === "string" && body.refresh_token) next.refreshToken = body.refresh_token;

  try {
    await prisma.tenantConnector.update({
      where: { id: install.id },
      data: {
        encryptedCredentials: encrypt(JSON.stringify(next), `${tenantId}|tenant_connector|${install.connector.id}`),
      },
    });
  } catch {
    // Without persistence a rotated refresh token would be lost: refuse.
    throw new OAuthRefreshError();
  }
  return next;
}

/** Returns fresh credentials (refreshing at most once per connector at a time) or throws OAuthRefreshError. */
export function ensureFreshCredentials(
  tenantId: string,
  install: RefreshInstall,
  creds: Record<string, string>,
): Promise<Record<string, string>> {
  if (!needsRefresh(install.connector.authMethod, creds)) return Promise.resolve(creds);
  const existing = inflight.get(install.id);
  if (existing) return existing;
  const p = doRefresh(tenantId, install, creds).finally(() => inflight.delete(install.id));
  inflight.set(install.id, p);
  return p;
}
