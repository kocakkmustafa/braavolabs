/**
 * Signed one-click unsubscribe tokens (RFC 8058 List-Unsubscribe).
 *
 * token = base64url(JSON {t: tenantId, e: normalised email, x: expiry epoch s})
 *         + "." + base64url(HMAC-SHA256(key, payloadPart))
 *
 * The HMAC key is derived with HKDF-SHA256 from the existing JWT secret
 * (read only through `env`), with a purpose-specific info string, so a token
 * can never be replayed as a JWT and vice versa. Tokens expire (not
 * perpetual); a verifier never throws, it returns null.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { normalizeEmail } from "./email-suppression";

const HKDF_SALT = "braavolabs-outbound-unsubscribe";
const HKDF_INFO = "braavolabs-unsubscribe-token-v1";
/** Long enough for a late opt-out from an old email, still finite. */
export const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 400 * 24 * 60 * 60;
const MAX_TOKEN_CHARS = 1024;

function signingKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(env.JWT_SECRET, "utf8"), HKDF_SALT, HKDF_INFO, 32));
}

function sign(payloadPart: string): string {
  return createHmac("sha256", signingKey()).update(payloadPart).digest("base64url");
}

export function createUnsubscribeToken(
  tenantId: string,
  email: string,
  nowMs: number = Date.now(),
): string {
  const payload = {
    t: tenantId,
    e: normalizeEmail(email),
    x: Math.floor(nowMs / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadPart}.${sign(payloadPart)}`;
}

export function verifyUnsubscribeToken(
  token: unknown,
  nowMs: number = Date.now(),
): { tenantId: string; email: string } | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts as [string, string];
  const expected = Buffer.from(sign(payloadPart));
  const given = Buffer.from(signaturePart);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      t?: unknown;
      e?: unknown;
      x?: unknown;
    };
    if (typeof payload.t !== "string" || typeof payload.e !== "string" || typeof payload.x !== "number") return null;
    if (!payload.t || !payload.e) return null;
    if (payload.x * 1000 <= nowMs) return null;
    return { tenantId: payload.t, email: payload.e };
  } catch {
    return null;
  }
}

/** https only (List-Unsubscribe requires it); null when the API origin is not https. */
export function buildUnsubscribeUrl(tenantId: string, email: string): string | null {
  const origin = String(env.API_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!origin.startsWith("https://")) return null;
  return `${origin}/api/v1/public/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(tenantId, email))}`;
}
