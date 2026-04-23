import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption module — AES-256-GCM with a scrypt-derived key (ISS-008).
 *
 * Format (v2 — current, scrypt KDF):
 *   "v2:" + base64( salt(16) + iv(16) + tag(16) + ciphertext )
 *
 * Format (v1 — legacy, raw UTF-8 slice key):
 *   base64( iv(16) + tag(16) + ciphertext )
 *
 * Decrypt detects the version by the "v2:" string prefix (binary v1 data
 * never starts with the literal characters "v2:" because the first 16 bytes
 * are the random IV). All new encryptions use v2; v1 is read-only for
 * backward compatibility with any rows persisted before this migration.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const V2_PREFIX = "v2:";

const PLACEHOLDER_FRAGMENTS = [
  "change-me",
  "your-32-character",
  "PLEASE_GENERATE",
  "REPLACE_ME",
];

function getRawKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error("ENCRYPTION_KEY must be at least 32 characters");
  }
  // Refuse the well-known placeholders in production. A real ENCRYPTION_KEY
  // should be generated with `openssl rand -hex 32` and kept in a secret
  // store. Placeholder values + a database dump = trivial decryption of
  // every customer's HubSpot/Stripe/Claude API key.
  if (process.env.NODE_ENV === "production") {
    const lower = key.toLowerCase();
    for (const fragment of PLACEHOLDER_FRAGMENTS) {
      if (lower.includes(fragment.toLowerCase())) {
        throw new Error(
          `ENCRYPTION_KEY appears to be a placeholder ("${fragment}" detected). ` +
            "Generate a real key: openssl rand -hex 32",
        );
      }
    }
  }
  return key;
}

function deriveKey(salt: Buffer): Buffer {
  // scrypt is deliberately slow (CPU + memory) — protects against offline
  // brute force if the salt + ciphertext leak. N=2^14, r=8, p=1 are the
  // Node defaults and give ~50ms/op on modern hardware, which is fine
  // because we only derive once per encrypt/decrypt and credentials are
  // accessed infrequently.
  return scryptSync(getRawKey(), salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a scrypt-derived key.
 * Always emits the v2 format. Returns "v2:" + base64( salt + iv + tag + ct ).
 */
export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();

  return V2_PREFIX + Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt an AES-256-GCM encrypted string. Auto-detects v1 (legacy raw-slice
 * key) and v2 (current scrypt KDF) formats.
 */
export function decrypt(encoded: string): string {
  if (encoded.startsWith(V2_PREFIX)) {
    return decryptV2(encoded.slice(V2_PREFIX.length));
  }
  return decryptV1Legacy(encoded);
}

function decryptV2(encodedWithoutPrefix: string): string {
  const data = Buffer.from(encodedWithoutPrefix, "base64");
  if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error("decrypt: v2 ciphertext too short");
  }

  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

function decryptV1Legacy(encoded: string): string {
  const data = Buffer.from(encoded, "base64");
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("decrypt: v1 ciphertext too short");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  // Legacy key derivation: raw UTF-8 slice. Kept ONLY for read-back
  // compatibility with rows encrypted before the v2 migration.
  const legacyKey = Buffer.from(getRawKey().slice(0, KEY_LENGTH), "utf8");
  const decipher = createDecipheriv(ALGORITHM, legacyKey, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}
