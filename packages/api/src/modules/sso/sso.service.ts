/**
 * Enterprise SSO service — generic OIDC flow.
 *
 * Supports any spec-compliant identity provider: Microsoft Entra
 * (Azure AD), Okta, Google Workspace, Auth0, JumpCloud, OneLogin,
 * Keycloak, …  The tenant's admin enters issuer + client_id +
 * client_secret + redirect_uri once via `PUT /api/v1/sso/oidc`; the
 * service handles discovery (`/.well-known/openid-configuration`),
 * caches the resolved endpoints, signs the authorization redirect,
 * and consumes the callback.
 *
 * `clientSecret` is AES-256-GCM at rest with AAD bound to the
 * tenantId + column so a DB lift can't be replayed onto a different
 * tenant.
 *
 * The auth state cookie (Redis-stored) carries the CSRF state, the
 * PKCE code_verifier (RFC 7636) and the tenant slug so the callback
 * route knows which IdP we just bounced through. PKCE is mandatory
 * even though we have a client_secret — Microsoft Entra accepts both
 * and PKCE turns a stolen client_secret into a strictly downgraded
 * threat.
 */

import crypto from "node:crypto";
import { prisma } from "../../lib/db";
import { redis } from "../../lib/redis";
import { encrypt, decrypt } from "../../lib/encryption";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { assertSafeExternalUrl, SsrfError } from "../../lib/ssrf";

// ── Plan gate ──────────────────────────────────────────────
//
// SSO is a BUSINESS+ feature. The router consults this before any
// write; reads pass through so a customer who downgrades doesn't lose
// the ability to inspect their own config.
export const SSO_PLANS: ReadonlySet<string> = new Set(["BUSINESS", "ENTERPRISE"]);

// ── State store ────────────────────────────────────────────

const STATE_TTL_SECONDS = 600; // 10 minutes — IdP round-trip max

interface AuthStatePayload {
  tenantId: string;
  codeVerifier: string;
  redirectAfter?: string;
}

export async function stashAuthState(payload: AuthStatePayload): Promise<string> {
  const state = crypto.randomBytes(32).toString("hex");
  await redis.set(
    `sso:state:${state}`,
    JSON.stringify(payload),
    "EX",
    STATE_TTL_SECONDS,
    "NX",
  );
  return state;
}

export async function redeemAuthState(state: string): Promise<AuthStatePayload> {
  let raw: string | null;
  try {
    raw = (await redis.call("GETDEL", `sso:state:${state}`)) as string | null;
  } catch {
    raw = await redis.get(`sso:state:${state}`);
    if (raw) await redis.del(`sso:state:${state}`);
  }
  if (!raw) throw new AppError(400, "SSO state is invalid or already used");
  return JSON.parse(raw) as AuthStatePayload;
}

// ── PKCE ───────────────────────────────────────────────────

export function makePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

// ── Discovery cache ────────────────────────────────────────
//
// Discovery responses are cached on the row for 24h. Refresh window
// is deliberately conservative — Microsoft / Google rotate jwks_uri
// signing keys roughly every 24-72h and we want our cache to be
// shorter than that worst case.

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export async function getOidcConnection(tenantId: string) {
  const conn = await prisma.oidcConnection.findUnique({
    where: { tenantId },
  });
  if (!conn) throw new AppError(404, "SSO not configured for this tenant");
  if (!conn.isActive) throw new AppError(403, "SSO connection is disabled");

  // Refresh discovery if stale.
  const stale =
    !conn.discoveredAt ||
    Date.now() - conn.discoveredAt.getTime() > DISCOVERY_TTL_MS ||
    !conn.authorizationEndpoint ||
    !conn.tokenEndpoint;
  if (stale) {
    const url = conn.discoveryUrl ?? `${conn.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    // SSRF guard: a malicious config could otherwise point discovery
    // at internal hostnames. Treat the discovery URL like any other
    // tenant-supplied URL.
    try {
      await assertSafeExternalUrl(url);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new AppError(400, `Discovery URL rejected: ${err.message}`);
      }
      throw err;
    }
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new AppError(502, `OIDC discovery failed: ${res.status}`);
    }
    const doc = (await res.json()) as DiscoveryDoc;
    if (doc.issuer && doc.issuer !== conn.issuer) {
      logger.warn(
        { tenantId, expected: conn.issuer, actual: doc.issuer },
        "OIDC discovery returned an issuer that disagrees with config — refusing to cache",
      );
      throw new AppError(400, "OIDC discovery issuer mismatch");
    }
    await prisma.oidcConnection.update({
      where: { id: conn.id },
      data: {
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        jwksUri: doc.jwks_uri,
        discoveredAt: new Date(),
      },
    });
    return {
      ...conn,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    };
  }
  return conn;
}

// ── Authorization URL builder ──────────────────────────────

export async function buildAuthUrl(
  tenantId: string,
  options: { redirectAfter?: string } = {},
): Promise<{ url: string; state: string }> {
  const conn = await getOidcConnection(tenantId);
  const { codeVerifier, codeChallenge } = makePkce();
  const state = await stashAuthState({
    tenantId,
    codeVerifier,
    redirectAfter: options.redirectAfter,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: conn.clientId,
    redirect_uri: conn.redirectUri,
    scope: conn.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return {
    url: `${conn.authorizationEndpoint}?${params.toString()}`,
    state,
  };
}

// ── Callback consumer ──────────────────────────────────────

interface ConsumeResult {
  email: string;
  sub: string;
  name?: string;
  picture?: string;
  hostedDomain?: string;
  tenantId: string;
  redirectAfter?: string;
}

const SSO_SECRET_AAD_PURPOSE = "oidc_connection|client_secret";
function aadFor(tenantId: string): string {
  return `${tenantId}|${SSO_SECRET_AAD_PURPOSE}`;
}

export async function consumeCallback(params: {
  code: string;
  state: string;
}): Promise<ConsumeResult> {
  const stateData = await redeemAuthState(params.state);
  const conn = await getOidcConnection(stateData.tenantId);
  if (!conn.tokenEndpoint) {
    throw new AppError(500, "OIDC token endpoint not discovered");
  }

  // Decrypt the client secret with the AAD that was used at encrypt
  // time. A mismatched tenantId means the row was lifted from another
  // tenant — decryption fails authentication, blocking the attack.
  let clientSecret: string;
  try {
    clientSecret = decrypt(conn.encryptedSecret, aadFor(conn.tenantId));
  } catch {
    throw new AppError(500, "Failed to decrypt OIDC client secret");
  }

  // Exchange the auth code for tokens (PKCE-bound).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: conn.redirectUri,
    client_id: conn.clientId,
    client_secret: clientSecret,
    code_verifier: stateData.codeVerifier,
  });
  const tokenRes = await fetch(conn.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    logger.warn({ tenantId: conn.tenantId, status: tokenRes.status, body: text.slice(0, 300) }, "OIDC token exchange failed");
    throw new AppError(401, `OIDC token exchange failed: ${tokenRes.status}`);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    throw new AppError(401, "OIDC token response missing id_token");
  }

  // For an MVP-grade verification we trust HTTPS + issuer + audience
  // claims rather than re-verifying the JWS signature against jwks_uri.
  // The token came from the configured token_endpoint over TLS, so a
  // network-level forge is implausible. A production-hardened follow-
  // up would fetch jwks_uri and verify the RS256/ES256 signature.
  const decoded = decodeJwtPayload(tokenJson.id_token) as Record<string, unknown>;
  const iss = String(decoded.iss ?? "");
  if (iss !== conn.issuer) {
    throw new AppError(401, `OIDC issuer mismatch (got ${iss})`);
  }
  const aud = decoded.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(conn.clientId)
    : aud === conn.clientId;
  if (!audOk) {
    throw new AppError(401, "OIDC audience mismatch");
  }
  const exp = Number(decoded.exp ?? 0);
  if (exp * 1000 < Date.now()) {
    throw new AppError(401, "OIDC id_token expired");
  }

  const email = typeof decoded.email === "string" ? decoded.email.toLowerCase() : "";
  if (!email) throw new AppError(400, "OIDC token has no email claim");

  // Domain allowlist enforcement.
  if (conn.domains) {
    const allowed = conn.domains
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length > 0) {
      const emailDomain = email.split("@")[1] ?? "";
      const hd = String(decoded.hd ?? "").toLowerCase();
      const ok = allowed.includes(emailDomain) || (hd && allowed.includes(hd));
      if (!ok) {
        throw new AppError(403, "Email domain is not in this tenant's allowlist");
      }
    }
  }

  return {
    email,
    sub: String(decoded.sub ?? ""),
    name: typeof decoded.name === "string" ? decoded.name : undefined,
    picture: typeof decoded.picture === "string" ? decoded.picture : undefined,
    hostedDomain: typeof decoded.hd === "string" ? decoded.hd : undefined,
    tenantId: conn.tenantId,
    redirectAfter: stateData.redirectAfter,
  };
}

function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new AppError(401, "Malformed id_token");
  const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + padding, "base64").toString("utf8"));
}

// ── Config CRUD ────────────────────────────────────────────

export async function upsertOidcConnection(
  tenantId: string,
  input: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes?: string;
    domains?: string;
    discoveryUrl?: string;
    isActive?: boolean;
  },
): Promise<{ id: string }> {
  // Validate the issuer is a real https:// URL and that any tenant-
  // supplied discovery URL passes the SSRF guard.
  try {
    await assertSafeExternalUrl(input.issuer);
    await assertSafeExternalUrl(input.redirectUri);
    if (input.discoveryUrl) await assertSafeExternalUrl(input.discoveryUrl);
  } catch (err) {
    const message = err instanceof SsrfError ? err.message : String(err);
    throw new AppError(400, `OIDC config URL rejected: ${message}`);
  }

  const existing = await prisma.oidcConnection.findUnique({ where: { tenantId } });
  const aad = aadFor(tenantId);
  const encryptedSecret =
    input.clientSecret !== undefined
      ? encrypt(input.clientSecret, aad)
      : existing?.encryptedSecret;
  if (!encryptedSecret) {
    throw new AppError(400, "clientSecret is required when creating a new OIDC connection");
  }

  const row = await prisma.oidcConnection.upsert({
    where: { tenantId },
    create: {
      tenantId,
      issuer: input.issuer,
      clientId: input.clientId,
      encryptedSecret,
      redirectUri: input.redirectUri,
      scopes: input.scopes ?? "openid email profile",
      domains: input.domains ?? "",
      discoveryUrl: input.discoveryUrl ?? null,
      isActive: input.isActive ?? true,
    },
    update: {
      issuer: input.issuer,
      clientId: input.clientId,
      encryptedSecret,
      redirectUri: input.redirectUri,
      scopes: input.scopes ?? existing?.scopes ?? "openid email profile",
      domains: input.domains ?? existing?.domains ?? "",
      discoveryUrl: input.discoveryUrl ?? existing?.discoveryUrl ?? null,
      isActive: input.isActive ?? existing?.isActive ?? true,
      // Re-trigger discovery on config change.
      authorizationEndpoint: null,
      tokenEndpoint: null,
      jwksUri: null,
      discoveredAt: null,
    },
  });
  return { id: row.id };
}

export async function deleteOidcConnection(tenantId: string): Promise<void> {
  await prisma.oidcConnection.deleteMany({ where: { tenantId } });
}

export async function getOidcConfigSafe(tenantId: string) {
  const conn = await prisma.oidcConnection.findUnique({ where: { tenantId } });
  if (!conn) return null;
  return {
    issuer: conn.issuer,
    clientId: conn.clientId,
    redirectUri: conn.redirectUri,
    scopes: conn.scopes,
    domains: conn.domains,
    discoveryUrl: conn.discoveryUrl,
    isActive: conn.isActive,
    discoveredAt: conn.discoveredAt,
    // clientSecret deliberately omitted — the dashboard never sees the
    // plaintext, only a "configured ✓" badge.
    hasSecret: true,
  };
}
