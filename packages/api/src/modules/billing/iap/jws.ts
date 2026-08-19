/**
 * Apple JWS (JSON Web Signature) x5c chain verification.
 *
 * FINDINGS C1 — App Store Server Notifications V2 arrive at our
 * UNAUTHENTICATED `/billing/iap/apple/notify` endpoint as an attacker-
 * reachable `signedPayload`. The previous code base64-decoded the JWS
 * payload WITHOUT verifying Apple's signature (apple.ts `decodeJws`,
 * acknowledged as SEC-001), so anyone who could POST to the endpoint
 * supplied an arbitrary `originalTransactionId`/`productId` that then
 * drove a Server-API re-fetch and a tenant plan mutation.
 *
 * This module verifies that a JWS was actually signed by Apple:
 *   1. the protected header carries an `x5c` certificate chain;
 *   2. each cert in the chain is signed by the next;
 *   3. the chain is anchored to Apple Root CA - G3 (pinned below);
 *   4. every cert is within its validity window;
 *   5. the JWS signature verifies against the leaf certificate's key.
 *
 * Only used on the notification (push) path — the Server-API response
 * path in apple.ts is authenticated by our outbound HTTPS request, so it
 * does not need x5c verification (and Apple does not always populate x5c
 * there identically).
 */

import { importX509, compactVerify } from "jose";
import { X509Certificate } from "node:crypto";

// Apple Root CA - G3 (public). Source:
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SHA-256 fingerprint:
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/**
 * Maximum x5c chain length accepted. Apple sends leaf + intermediate + root;
 * anything beyond this is either malformed or an attempt to make an
 * unauthenticated request expensive to reject.
 */
const MAX_X5C_CHAIN = 5;

export class JwsVerificationError extends Error {}

export interface VerifyJwsOptions {
  /** Trusted root certs (PEM). Defaults to the pinned Apple Root CA - G3.
   *  Overridable so tests can anchor a locally-generated chain. */
  trustedRootsPem?: string[];
  /** Clock for validity-window checks. Defaults to the current time. */
  now?: Date;
}

function b64urlToJson(b64url: string): Record<string, unknown> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as Record<string, unknown>;
}

/**
 * Verify an Apple-signed compact JWS and return its decoded payload.
 * Throws `JwsVerificationError` on any structural, chain, validity, or
 * signature failure. ES256 only (the algorithm Apple uses).
 */
export async function verifyAppleJws(
  jws: string,
  opts: VerifyJwsOptions = {},
): Promise<Record<string, unknown>> {
  if (typeof jws !== "string") throw new JwsVerificationError("JWS is not a string");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new JwsVerificationError("Invalid JWS shape");

  let header: { alg?: string; x5c?: unknown };
  try {
    header = b64urlToJson(parts[0]) as { alg?: string; x5c?: unknown };
  } catch {
    throw new JwsVerificationError("Invalid JWS header");
  }
  // Pin the algorithm — never let the header downgrade us to "none" or
  // an unexpected curve.
  if (header.alg !== "ES256") {
    throw new JwsVerificationError(`Unexpected JWS alg: ${String(header.alg)}`);
  }
  if (!Array.isArray(header.x5c) || header.x5c.length < 2) {
    throw new JwsVerificationError("JWS missing x5c certificate chain");
  }
  // Cap the chain BEFORE parsing or verifying anything. Apple's real chain is
  // leaf + intermediate + root; MAX_X5C_CHAIN leaves headroom without letting
  // an unauthenticated caller buy an unbounded number of ECDSA verifications
  // (this endpoint is a public webhook — see the F-8 tests in __tests__/jws.test.ts).
  if (header.x5c.length > MAX_X5C_CHAIN) {
    throw new JwsVerificationError(
      `JWS x5c chain is too long (${header.x5c.length} > ${MAX_X5C_CHAIN})`,
    );
  }

  let certs: X509Certificate[];
  try {
    certs = (header.x5c as string[]).map((b64) => new X509Certificate(Buffer.from(b64, "base64")));
  } catch {
    throw new JwsVerificationError("JWS x5c contains an invalid certificate");
  }

  const now = opts.now ?? new Date();
  for (const c of certs) {
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) {
      throw new JwsVerificationError("JWS certificate expired or not yet valid");
    }
  }

  // Anchoring is checked FIRST, before the pairwise walk. Order matters for
  // cost, not correctness: a chain of N identical self-signed certs is
  // internally consistent, so the pairwise loop would perform N-1 real ECDSA
  // verifications before anything rejected it. Anchoring is at most
  // len(trustedRoots) verifications and eliminates that amplification.
  const trustedRoots = (opts.trustedRootsPem ?? [APPLE_ROOT_CA_G3_PEM]).map(
    (pem) => new X509Certificate(pem),
  );
  const top = certs[certs.length - 1]!;
  const anchored = trustedRoots.some(
    (root) => top.raw.equals(root.raw) || top.verify(root.publicKey),
  );
  if (!anchored) {
    throw new JwsVerificationError("JWS x5c chain is not anchored to a trusted root");
  }

  // Each cert must be signed by the next one up the chain.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i]!.verify(certs[i + 1]!.publicKey)) {
      throw new JwsVerificationError("JWS x5c chain is broken");
    }
  }

  // Finally verify the JWS signature against the leaf certificate.
  let leafKey;
  try {
    leafKey = await importX509(certs[0]!.toString(), "ES256");
  } catch {
    throw new JwsVerificationError("Could not import leaf certificate key");
  }
  try {
    const { payload } = await compactVerify(jws, leafKey);
    return JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new JwsVerificationError("JWS signature verification failed");
  }
}
