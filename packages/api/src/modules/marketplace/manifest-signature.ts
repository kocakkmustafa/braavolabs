/**
 * Connector manifest HMAC signature (E5/T5).
 *
 * `manifestSignature` used to be STORED but never verified — a publisher could
 * publish one tool set, get approved, then swap the MCP server for a malicious
 * one and every tenant's `refresh` would silently pull the new tools. This
 * module closes that gap with a FULL HMAC sign + verify:
 *
 *   • publish-time  → sign the canonical tool surface with a per-publisher-
 *     tenant key, store the hex digest in Connector.manifestSignature.
 *   • install/refresh → re-canonicalize the live-probed tool set and verify it
 *     against the stored signature (using the PUBLISHER's tenant key). A
 *     mismatch means the tool surface changed after signing → reject.
 *
 * Key derivation reuses the SAME two-step scheme as the encryption module
 * (HKDF-SHA256 from the master ENCRYPTION_KEY, salted by the publisher's
 * tenantId) but is implemented HERE independently — encryption.ts is an
 * immutable dependency and must not be touched. No plaintext secret is ever
 * stored: the HMAC key is derived on demand from the master key + tenantId, so
 * a DB dump alone (without the master key) cannot forge a signature, and one
 * tenant's key can't sign for another's connectors.
 *
 * This needs NO new column — `Connector.manifestSignature` (String? @db.Text)
 * already exists; we simply start writing a real digest into it and verifying
 * it. No migration required.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalManifestPayload, type McpToolLike } from "@ai-company-os/connector-sdk";

const HMAC_ALGO = "sha256";
const KEY_LENGTH = 32;
// A distinct HKDF `info` string from the encryption module's
// "braavolabs-tenant-encryption-v4" so the manifest-signing subkey is
// domain-separated from the credential-encryption subkey even though both
// derive from the same master ENCRYPTION_KEY.
const HKDF_INFO = "braavolabs-connector-manifest-hmac-v1";
const SIG_PREFIX = "hmac-sha256:";

function getMasterKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error("ENCRYPTION_KEY must be at least 32 characters");
  }
  return Buffer.from(key, "utf8");
}

/** Derive the per-publisher-tenant HMAC key. Salt = publisher tenantId, so
 * each publisher signs with a distinct key. */
function deriveSigningKey(publisherTenantId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      getMasterKey(),
      Buffer.from(publisherTenantId, "utf8"),
      HKDF_INFO,
      KEY_LENGTH,
    ),
  );
}

/**
 * Sign the canonical tool surface of a manifest. Returns a prefixed hex
 * digest suitable for `Connector.manifestSignature`.
 */
export function signManifest(
  publisherTenantId: string,
  input: { slug: string; version: string; tools: McpToolLike[] },
): string {
  const payload = canonicalManifestPayload(input);
  const digest = createHmac(HMAC_ALGO, deriveSigningKey(publisherTenantId))
    .update(payload)
    .digest("hex");
  return SIG_PREFIX + digest;
}

/**
 * Verify a stored signature against the (live-probed) tool set. Uses a
 * constant-time comparison so a mismatch can't be probed by timing.
 *
 * Returns true only when the recomputed HMAC exactly matches the stored one.
 * A `null`/empty/legacy-format stored signature returns false (fail-closed —
 * caller decides whether an UNSIGNED connector is allowed; see the router).
 */
export function verifyManifest(
  publisherTenantId: string,
  storedSignature: string | null | undefined,
  input: { slug: string; version: string; tools: McpToolLike[] },
): boolean {
  if (!storedSignature || !storedSignature.startsWith(SIG_PREFIX)) return false;
  const expected = signManifest(publisherTenantId, input);
  const a = Buffer.from(storedSignature, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length
  // signature returns false instead of throwing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when a stored signature is in our HMAC format (vs. null/legacy). Lets
 * the router distinguish "unsigned, legacy connector" from "signed but
 * tampered". */
export function isSignedManifest(storedSignature: string | null | undefined): boolean {
  return !!storedSignature && storedSignature.startsWith(SIG_PREFIX);
}
