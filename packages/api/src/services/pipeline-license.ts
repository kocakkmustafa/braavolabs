/**
 * Pipeline export DRM — encrypts downloaded pipeline bundles to a
 * machine-bound, time-limited offline license.
 *
 * Threat model (what we're trying to stop):
 *   • Casual sharing: Alice downloads a pipeline, sends the file to Bob.
 *     Bob's runtime cannot decrypt it because his machine fingerprint
 *     differs.
 *   • Subscription cancellation: Alice cancels but keeps using the file.
 *     The 7-day JWT expires; without re-verifying online, the runtime
 *     refuses to run.
 *   • Lost-laptop: Alice replaces her laptop. The /change-machine endpoint
 *     rebinds (one swap per month by default), so legit upgrades work
 *     while industrial scaled sharing is friction-heavy.
 *
 * What we're NOT trying to stop:
 *   • A determined attacker with full access to a bound machine. Once
 *     they have the running runtime + the file + the fingerprint, they
 *     can decrypt. DRM is "raise the bar," not "Fort Knox."
 *
 * Crypto choices, with reasoning:
 *   • AES-256-GCM for the bundle: authenticated encryption, NIST-blessed.
 *     IV is 12 bytes random per encryption. Tag is 16 bytes.
 *   • Per-license random salt (32 bytes) is stored INSIDE the JWT payload
 *     so the runtime can recompute the AES key. Without the JWT, attacker
 *     has no salt → no key derivation possible. Without the fingerprint,
 *     attacker has no input → no key. Both required.
 *   • HKDF-SHA256 for key derivation. Domain-separation tag = "braavolabs:
 *     pipeline-export:v1" so a future protocol revision doesn't collide
 *     with existing files in the wild.
 *   • JWT signed HS256 with LICENSE_JWT_SECRET (independent of JWT_SECRET
 *     so license tokens can rotate without invalidating user sessions).
 *
 * Wire format of an encrypted bundle (JSON):
 *   {
 *     "license":   "<JWT>",
 *     "iv":        "<base64url, 12 bytes>",
 *     "tag":       "<base64url, 16 bytes>",
 *     "ciphertext": "<base64url>",
 *     "version":   1
 *   }
 *
 * The runtime SDK (separate package, not in this repo) is the consumer
 * of this format. Spec lives in docs/pipeline-drm.md.
 */
import * as crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";

// HKDF "info" — domain separation tag. Versioned so a future change to
// the derivation scheme can ship without breaking files already in the
// wild. Bumping this to v2 will require a coordinated runtime update.
const HKDF_INFO = Buffer.from("braavolabs:pipeline-export:v1", "utf8");
const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_LEN = 32; // 256-bit
const IV_LEN = 12;
const TAG_LEN = 16;
const KDF_SALT_LEN = 32;

const TOKEN_SUBJECT = "braavolabs.pipeline-license";

export interface LicensePayload {
  /** Tenant the license belongs to. */
  tenantId: string;
  /** Bound machine fingerprint hash (SHA-256 hex). Server-side check. */
  fingerprintHash: string;
  /** Per-license HKDF salt (base64). Combined with the raw fingerprint
   *  to derive the AES key. Stored in the JWT so the runtime can
   *  reconstruct the key without an extra round-trip. */
  kdfSalt: string;
  /** Optional pipeline ID — when present, the file is bound to one
   *  specific pipeline; when absent, the whole tenant bundle is wrapped. */
  pipelineId?: string;
  /** Standard JWT claims */
  iat?: number;
  exp?: number;
  sub?: string;
}

export interface EncryptedBundle {
  license: string;
  iv: string;
  tag: string;
  ciphertext: string;
  version: 1;
}

export interface BindOk {
  ok: true;
  /** True when this call established a NEW binding (machine swap or first bind). */
  rebound: boolean;
  /** Remaining changes for the current period (after the call). */
  remainingChanges: number;
  fingerprintHash: string;
}
export interface BindFail {
  ok: false;
  /** Machine-readable reason; the router maps this to HTTP status + copy. */
  reason: "different_machine" | "quota_exhausted" | "license_disabled";
  /** When `reason === 'different_machine'`, this is filled with the user-
   *  facing copy ("This machine fingerprint doesn't match the one bound on
   *  Apr 7, 2026. To switch, call /change-machine."). */
  message: string;
}
export type BindResult = BindOk | BindFail;

// ──────────────────────────────────────────────────────────
//  Crypto helpers — pure, no DB.
// ──────────────────────────────────────────────────────────

/** SHA-256 hex of a raw fingerprint string. We never store the raw value. */
export function hashFingerprint(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Derive a 32-byte AES key from raw fingerprint + per-license salt. */
function deriveAesKey(rawFingerprint: string, kdfSalt: Buffer): Buffer {
  // Node's hkdfSync returns ArrayBuffer — wrap to Buffer for symmetry.
  const out = crypto.hkdfSync(
    "sha256",
    Buffer.from(rawFingerprint, "utf8"),
    kdfSalt,
    HKDF_INFO,
    AES_KEY_LEN,
  );
  return Buffer.from(out);
}

function ensureSecret(): string {
  const secret = process.env.LICENSE_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "LICENSE_JWT_SECRET is missing or shorter than 32 chars. " +
        "Generate with: openssl rand -hex 32",
    );
  }
  return secret;
}

/** Sign a license JWT with the configured TTL. */
function signLicense(payload: Omit<LicensePayload, "iat" | "exp" | "sub">): string {
  const secret = ensureSecret();
  const ttlDays = env.LICENSE_TTL_DAYS;
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: `${ttlDays}d`,
    subject: TOKEN_SUBJECT,
  });
}

/** Verify a license JWT and return the decoded payload. Throws on invalid /
 * expired / wrong subject. */
export function verifyLicenseToken(token: string): LicensePayload {
  const secret = ensureSecret();
  const decoded = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    subject: TOKEN_SUBJECT,
  }) as LicensePayload;
  return decoded;
}

// ──────────────────────────────────────────────────────────
//  Public encrypt / decrypt
// ──────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string (typically JSON-stringified pipeline bundle)
 * into a machine-bound EncryptedBundle. Caller must supply the raw
 * fingerprint that the runtime will present at decryption time — usually
 * fetched from the bind row or from the user's just-submitted fingerprint.
 *
 * The output is safe to ship to the user — neither the AES key nor the
 * raw fingerprint travel in the bundle. The runtime recomputes the key
 * locally from its own fingerprint + the salt embedded in the JWT.
 */
export function encryptForMachine(
  plaintext: string,
  rawFingerprint: string,
  meta: { tenantId: string; pipelineId?: string },
): EncryptedBundle {
  const kdfSalt = crypto.randomBytes(KDF_SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const aesKey = deriveAesKey(rawFingerprint, kdfSalt);

  const cipher = crypto.createCipheriv(AES_ALGORITHM, aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (tag.length !== TAG_LEN) {
    // Belt-and-suspenders — GCM tag length is fixed but a future Node
    // upgrade or accidental option swap shouldn't silently produce a
    // shorter tag (which would weaken the authenticity guarantee).
    throw new Error(`AES-GCM tag length ${tag.length} != ${TAG_LEN}`);
  }

  const license = signLicense({
    tenantId: meta.tenantId,
    fingerprintHash: hashFingerprint(rawFingerprint),
    kdfSalt: kdfSalt.toString("base64"),
    pipelineId: meta.pipelineId,
  });

  return {
    license,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    version: 1,
  };
}

/**
 * Decrypt an EncryptedBundle on the SERVER side. The runtime SDK
 * implements its own decryption; this function is here for the
 * /api/license/verify endpoint to sanity-check that a token + fingerprint
 * pair produces a usable bundle (rather than throwing inside the runtime
 * for opaque reasons).
 *
 * We do NOT expose the plaintext via this function in the router — only
 * a boolean. The whole point of the system is that decryption happens
 * on the user's machine.
 */
export function decryptForMachine(
  bundle: EncryptedBundle,
  rawFingerprint: string,
): string {
  if (bundle.version !== 1) {
    throw new Error(`Unsupported bundle version: ${bundle.version}`);
  }
  const payload = verifyLicenseToken(bundle.license);
  if (payload.fingerprintHash !== hashFingerprint(rawFingerprint)) {
    throw new Error("Fingerprint mismatch — license is bound to a different machine");
  }
  const kdfSalt = Buffer.from(payload.kdfSalt, "base64");
  const iv = Buffer.from(bundle.iv, "base64url");
  const tag = Buffer.from(bundle.tag, "base64url");
  const ciphertext = Buffer.from(bundle.ciphertext, "base64url");
  const aesKey = deriveAesKey(rawFingerprint, kdfSalt);
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, aesKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// ──────────────────────────────────────────────────────────
//  Tenant bind / rebind logic (DB-backed)
// ──────────────────────────────────────────────────────────

/** "YYYY-MM" of `now` in UTC — matches what we store in
 * `monthly_change_period`. Using UTC keeps the period consistent across
 * timezones (a tenant in Tokyo and a tenant in NYC see the same reset
 * point). Trade-off: a user in UTC-08 might feel the quota reset "early
 * on the last day of the month." Acceptable. */
function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * First-bind or refresh-bind for a tenant. If `rebind` is false, this
 * either creates the row (first bind) OR succeeds when the fingerprint
 * matches the existing one. A different fingerprint with `rebind: false`
 * fails with `different_machine` — the caller should redirect the user
 * to /change-machine.
 *
 * With `rebind: true`, the call is allowed to overwrite the binding,
 * subject to the monthly quota. Quota period is reset on the first call
 * of a new calendar month (UTC) — no cron job needed.
 */
export async function bindMachine(
  tenantId: string,
  rawFingerprint: string,
  options: { rebind?: boolean } = {},
): Promise<BindResult> {
  if (!process.env.LICENSE_JWT_SECRET) {
    return {
      ok: false,
      reason: "license_disabled",
      message: "Pipeline DRM is disabled on this deployment (LICENSE_JWT_SECRET unset).",
    };
  }

  const fingerprintHash = hashFingerprint(rawFingerprint);
  const existing = await prisma.pipelineLicense.findUnique({ where: { tenantId } });

  // First bind — establish the row, no quota cost.
  if (!existing || !existing.deviceFingerprint) {
    const row = await prisma.pipelineLicense.upsert({
      where: { tenantId },
      create: {
        tenantId,
        deviceFingerprint: fingerprintHash,
        lastBoundAt: new Date(),
        monthlyChangePeriod: currentPeriod(),
      },
      update: {
        deviceFingerprint: fingerprintHash,
        lastBoundAt: new Date(),
      },
    });
    logger.info({ tenantId, fingerprintHash: fingerprintHash.slice(0, 12) }, "Pipeline license: first bind");
    return {
      ok: true,
      rebound: true,
      remainingChanges: env.LICENSE_MACHINE_CHANGES_PER_MONTH - row.monthlyMachineChangesUsed,
      fingerprintHash,
    };
  }

  // Same machine — no-op success.
  if (existing.deviceFingerprint === fingerprintHash) {
    return {
      ok: true,
      rebound: false,
      remainingChanges: Math.max(
        0,
        env.LICENSE_MACHINE_CHANGES_PER_MONTH - existing.monthlyMachineChangesUsed,
      ),
      fingerprintHash,
    };
  }

  // Different machine — only allowed via /change-machine (rebind=true).
  if (!options.rebind) {
    return {
      ok: false,
      reason: "different_machine",
      message: existing.lastBoundAt
        ? `This license is bound to a different machine (last bound ${existing.lastBoundAt.toISOString().slice(0, 10)}). Use the change-machine flow to switch.`
        : "This license is bound to a different machine. Use the change-machine flow to switch.",
    };
  }

  // Reset the period counter when we cross into a new calendar month.
  const period = currentPeriod();
  const usedThisPeriod =
    existing.monthlyChangePeriod === period ? existing.monthlyMachineChangesUsed : 0;

  if (usedThisPeriod >= env.LICENSE_MACHINE_CHANGES_PER_MONTH) {
    return {
      ok: false,
      reason: "quota_exhausted",
      message: `You've used all ${env.LICENSE_MACHINE_CHANGES_PER_MONTH} machine changes for this month. The quota resets on the 1st of next month.`,
    };
  }

  const updated = await prisma.pipelineLicense.update({
    where: { tenantId },
    data: {
      deviceFingerprint: fingerprintHash,
      lastBoundAt: new Date(),
      monthlyMachineChangesUsed: usedThisPeriod + 1,
      monthlyChangePeriod: period,
    },
  });

  logger.info(
    {
      tenantId,
      fingerprintHash: fingerprintHash.slice(0, 12),
      remainingChanges: env.LICENSE_MACHINE_CHANGES_PER_MONTH - updated.monthlyMachineChangesUsed,
    },
    "Pipeline license: rebound to new machine",
  );

  return {
    ok: true,
    rebound: true,
    remainingChanges: env.LICENSE_MACHINE_CHANGES_PER_MONTH - updated.monthlyMachineChangesUsed,
    fingerprintHash,
  };
}

/**
 * Lightweight verify call used by the runtime to check whether its
 * cached license is still good. Returns a structured result so the
 * client can show a useful message ("renew online" vs "wrong machine").
 */
export async function verifyLicenseFreshness(
  tokenString: string,
  rawFingerprint: string,
): Promise<
  | { ok: true; expiresAt: number; tenantId: string }
  | { ok: false; reason: "expired" | "fingerprint_mismatch" | "tampered" | "tenant_revoked"; message: string }
> {
  let payload: LicensePayload;
  try {
    payload = verifyLicenseToken(tokenString);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("expired")) {
      return { ok: false, reason: "expired", message: "License expired — re-verify online to refresh." };
    }
    return { ok: false, reason: "tampered", message: "License signature invalid." };
  }

  if (payload.fingerprintHash !== hashFingerprint(rawFingerprint)) {
    return {
      ok: false,
      reason: "fingerprint_mismatch",
      message: "Machine fingerprint doesn't match the bound machine. Use /change-machine to switch.",
    };
  }

  // Cross-check with the DB — if the tenant's binding was rotated since
  // this token was issued, fail the check so revoked machines stop working.
  const row = await prisma.pipelineLicense.findUnique({
    where: { tenantId: payload.tenantId },
  });
  if (!row || row.deviceFingerprint !== payload.fingerprintHash) {
    return {
      ok: false,
      reason: "tenant_revoked",
      message: "Tenant binding was changed since this license was issued.",
    };
  }

  return {
    ok: true,
    expiresAt: payload.exp ? payload.exp * 1000 : 0,
    tenantId: payload.tenantId,
  };
}
