/**
 * Pipeline DRM crypto round-trip tests. The bind/quota logic touches
 * Prisma and is exercised by integration tests; here we keep the focus
 * on the pure-crypto side: encrypt → decrypt with the right fingerprint
 * works, encrypt → decrypt with the wrong fingerprint fails.
 *
 * Crypto bugs are silent failures — wrong AES key with the same input
 * shape produces gibberish, not an exception. So the assertion that
 * "wrong fingerprint throws" is what gives us confidence the binding
 * is real, not just decorative.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const ORIGINAL_SECRET = process.env.LICENSE_JWT_SECRET;

// The service reads `process.env.LICENSE_JWT_SECRET` at call time, not
// at module import — so setting it here (before each test runs) is
// enough. We restore the original value in afterAll so other test files
// in the same vitest worker don't see a leaked secret.
beforeAll(() => {
  process.env.LICENSE_JWT_SECRET = "x".repeat(64);
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.LICENSE_JWT_SECRET;
  } else {
    process.env.LICENSE_JWT_SECRET = ORIGINAL_SECRET;
  }
});

import {
  encryptForMachine,
  decryptForMachine,
  hashFingerprint,
  verifyLicenseToken,
} from "../pipeline-license";

const SAMPLE_PLAINTEXT = JSON.stringify({
  pipeline: "demo",
  agents: [{ name: "Cassia", model: "claude-sonnet-4-20250514" }],
});

describe("Pipeline DRM crypto round-trip", () => {
  it("encrypt → decrypt with the same fingerprint returns the original plaintext", () => {
    const fp = "macbook-pro-cpu-m2-host-aurora-mac-aabbccddeeff";
    const bundle = encryptForMachine(SAMPLE_PLAINTEXT, fp, {
      tenantId: "ten_test",
      pipelineId: "pip_test",
    });

    expect(bundle.version).toBe(1);
    expect(bundle.license.length).toBeGreaterThan(20);
    expect(bundle.iv.length).toBeGreaterThan(0);
    expect(bundle.tag.length).toBeGreaterThan(0);

    const decrypted = decryptForMachine(bundle, fp);
    expect(decrypted).toBe(SAMPLE_PLAINTEXT);
  });

  it("encrypt → decrypt with a DIFFERENT fingerprint throws (machine-bound)", () => {
    const fp1 = "machine-one-host-alpha";
    const fp2 = "machine-two-host-bravo";
    const bundle = encryptForMachine(SAMPLE_PLAINTEXT, fp1, {
      tenantId: "ten_test",
    });

    // The mismatch is caught at the JWT layer first ("Fingerprint
    // mismatch — license is bound to a different machine"), but if
    // someone tampers with the JWT to lie about the fingerprint, AES-GCM
    // auth tag verification fails. Either way → throw.
    expect(() => decryptForMachine(bundle, fp2)).toThrow(/fingerprint mismatch|auth/i);
  });

  it("hashFingerprint is stable + 64-char SHA-256 hex", () => {
    const fp = "macbook-pro-aurora-aabbccddeeff";
    const h = hashFingerprint(fp);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(hashFingerprint(fp)).toBe(h);

    // Different input → different hash (basic collision sanity).
    expect(hashFingerprint("different")).not.toBe(h);
  });

  it("verifyLicenseToken accepts our own freshly-signed token and rejects garbage", () => {
    const fp = "machine-verify-test-host-charlie";
    const bundle = encryptForMachine(SAMPLE_PLAINTEXT, fp, { tenantId: "ten_v" });

    const payload = verifyLicenseToken(bundle.license);
    expect(payload.tenantId).toBe("ten_v");
    expect(payload.fingerprintHash).toBe(hashFingerprint(fp));
    expect(payload.kdfSalt.length).toBeGreaterThan(20);
    expect(typeof payload.exp).toBe("number");

    expect(() => verifyLicenseToken("not.a.real.token")).toThrow();
  });

  it("each encryption uses a fresh IV + salt (no key reuse)", () => {
    const fp = "machine-noncetest-host-delta";
    const a = encryptForMachine(SAMPLE_PLAINTEXT, fp, { tenantId: "ten_n" });
    const b = encryptForMachine(SAMPLE_PLAINTEXT, fp, { tenantId: "ten_n" });

    // Ciphertext + IV should differ even for identical plaintext+fingerprint
    // — that's the whole point of GCM nonce uniqueness.
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);

    // But both decrypt back to the same plaintext with the same fingerprint.
    expect(decryptForMachine(a, fp)).toBe(SAMPLE_PLAINTEXT);
    expect(decryptForMachine(b, fp)).toBe(SAMPLE_PLAINTEXT);
  });
});
