/**
 * Sign in with Apple token revocation for account erasure (F04).
 *
 * Apple requires apps that offer SIWA and account deletion to revoke the
 * user's tokens (POST https://appleid.apple.com/auth/revoke). We do not keep
 * Apple refresh tokens, so revocation needs a fresh `authorizationCode` from
 * the client (obtained right before deletion) plus the SIWA key configuration:
 * code -> /auth/token -> refresh_token -> /auth/revoke.
 *
 * The outcome is always explicit; we never report a revocation we did not
 * observe:
 *   - NOT_LINKED     the account has no Apple identity.
 *   - REVOKED        Apple accepted the revoke request (HTTP 200).
 *   - APPLE_PENDING  revocation could not be attempted (no code, no config,
 *                    or Apple rejected the code); the user must remove access
 *                    in Apple ID settings.
 *   - UNKNOWN        the revoke request was sent but its result is unknown
 *                    (timeout, network error, unexpected status).
 * No token, code, or key material is logged or returned.
 */
import { SignJWT, importPKCS8 } from "jose";

export type AppleRevocationOutcome = "NOT_LINKED" | "REVOKED" | "APPLE_PENDING" | "UNKNOWN";

export interface AppleRevocationConfig {
  clientId?: string;
  teamId?: string;
  keyId?: string;
  privateKey?: string;
}

const APPLE_AUDIENCE = "https://appleid.apple.com";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const REQUEST_TIMEOUT_MS = 5_000;

export function appleAccessRemovalRequired(outcome: AppleRevocationOutcome): boolean {
  return outcome === "APPLE_PENDING" || outcome === "UNKNOWN";
}

async function clientSecret(config: Required<AppleRevocationConfig>, now: Date): Promise<string> {
  const key = await importPKCS8(config.privateKey, "ES256");
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(key);
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export async function revokeAppleAccess(options: {
  appleId: string | null | undefined;
  authorizationCode?: string | null;
  config: AppleRevocationConfig;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<AppleRevocationOutcome> {
  if (!options.appleId) return "NOT_LINKED";
  const { clientId, teamId, keyId, privateKey } = options.config;
  if (!options.authorizationCode || !clientId || !teamId || !keyId || !privateKey) return "APPLE_PENDING";
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { "content-type": "application/x-www-form-urlencoded" };

  let secret: string;
  try {
    secret = await clientSecret({ clientId, teamId, keyId, privateKey }, options.now ?? new Date());
  } catch {
    return "APPLE_PENDING"; // unusable key configuration: nothing was sent to Apple
  }

  let refreshToken: string | undefined;
  try {
    const response = await fetchImpl(APPLE_TOKEN_URL, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: form({ client_id: clientId, client_secret: secret, code: options.authorizationCode, grant_type: "authorization_code" }),
    });
    if (!response.ok) return "APPLE_PENDING"; // code rejected/expired: no token to revoke
    const body = (await response.json()) as { refresh_token?: unknown };
    refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
  } catch {
    return "APPLE_PENDING";
  }
  if (!refreshToken) return "APPLE_PENDING";

  try {
    const response = await fetchImpl(APPLE_REVOKE_URL, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: form({ client_id: clientId, client_secret: secret, token: refreshToken, token_type_hint: "refresh_token" }),
    });
    return response.status === 200 ? "REVOKED" : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
