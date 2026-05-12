import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";

// ENCRYPTION_KEY must exist before encryption.ts is imported (top-level
// access happens inside the module's getRawKey on every encrypt/decrypt
// call, but module evaluation does not throw on import — set it once
// here for the entire suite).
const REAL_KEY = "0".repeat(64);

beforeAll(() => {
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = REAL_KEY;
  }
});

let encryptModule: typeof import("../encryption");

beforeAll(async () => {
  encryptModule = await import("../encryption");
});

describe("encrypt / decrypt round-trip (v3 — scrypt KDF + 12-byte IV + AAD)", () => {
  it("recovers the original UTF-8 plaintext", () => {
    const original = "hello, encrypted world";
    const ct = encryptModule.encrypt(original);
    expect(encryptModule.decrypt(ct)).toBe(original);
  });

  it("emits ciphertext with the v3: prefix", () => {
    const ct = encryptModule.encrypt("foo");
    expect(ct.startsWith("v3:")).toBe(true);
  });

  it("binds AAD into the auth tag — wrong AAD fails decrypt", () => {
    const ct = encryptModule.encrypt("aad-secret", "tenant-A|row-1|col");
    expect(encryptModule.decrypt(ct, "tenant-A|row-1|col")).toBe("aad-secret");
    expect(() => encryptModule.decrypt(ct, "tenant-B|row-1|col")).toThrow();
    expect(() => encryptModule.decrypt(ct)).toThrow();
  });

  it("produces different ciphertext for the same plaintext (random salt + IV)", () => {
    const a = encryptModule.encrypt("same input");
    const b = encryptModule.encrypt("same input");
    expect(a).not.toBe(b);
    expect(encryptModule.decrypt(a)).toBe(encryptModule.decrypt(b));
  });

  it("handles empty string", () => {
    const ct = encryptModule.encrypt("");
    expect(encryptModule.decrypt(ct)).toBe("");
  });

  it("handles non-ASCII unicode (emoji, CJK)", () => {
    const original = "🔒 Braavolabs — 安全";
    const ct = encryptModule.encrypt(original);
    expect(encryptModule.decrypt(ct)).toBe(original);
  });

  it("handles long strings (>1KB)", () => {
    const original = "x".repeat(2048);
    const ct = encryptModule.encrypt(original);
    expect(encryptModule.decrypt(ct)).toBe(original);
  });
});

describe("decrypt — v1 legacy compatibility (raw-slice key)", () => {
  // Build a v1 ciphertext using the same algorithm (AES-256-GCM) but with
  // the legacy KDF: raw UTF-8 slice of the first 32 chars of ENCRYPTION_KEY.
  // No "v2:" prefix → encryption.ts dispatches to decryptV1Legacy.
  //
  // Reads ENCRYPTION_KEY from process.env at CALL TIME (not module-load
  // time) so the test stays correct regardless of how the runner seeds
  // the env. Earlier this was hard-coded to REAL_KEY, which silently
  // broke when CI set a different ENCRYPTION_KEY (legacy key derived
  // here ≠ legacy key used by decryptV1Legacy → auth-tag mismatch).
  function makeV1Ciphertext(plaintext: string): string {
    const rawKey = process.env.ENCRYPTION_KEY;
    if (!rawKey) throw new Error("ENCRYPTION_KEY missing in test env");
    const iv = randomBytes(16);
    const legacyKey = Buffer.from(rawKey.slice(0, 32), "utf8");
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  it("decrypts v1 ciphertext using the legacy raw-slice key", () => {
    const original = "legacy-secret";
    const v1 = makeV1Ciphertext(original);
    expect(v1.startsWith("v3:")).toBe(false);
    expect(v1.startsWith("v2:")).toBe(false);
    expect(encryptModule.decrypt(v1)).toBe(original);
  });

  it("throws on truncated v1 ciphertext (shorter than IV+TAG)", () => {
    const tooShort = Buffer.from("x".repeat(20)).toString("base64");
    expect(() => encryptModule.decrypt(tooShort)).toThrow(/v1 ciphertext too short/);
  });
});

describe("decrypt — v3 invariants and tamper-detection", () => {
  it("throws on truncated v3 ciphertext", () => {
    const tooShort = "v3:" + Buffer.from("x".repeat(20)).toString("base64");
    expect(() => encryptModule.decrypt(tooShort)).toThrow(/v3 ciphertext too short/);
  });

  it("rejects v3 ciphertext with a flipped tag byte (auth fails)", () => {
    const ct = encryptModule.encrypt("tamper-me");
    const raw = Buffer.from(ct.slice(3), "base64");
    // v3 layout: salt[0..15] + iv[16..27] (12 bytes) + tag[28..43] + ct[44..].
    // Flip one bit inside the auth tag.
    raw[28] ^= 0xff;
    const tampered = "v3:" + raw.toString("base64");
    expect(() => encryptModule.decrypt(tampered)).toThrow();
  });
});

describe("ENCRYPTION_KEY validation", () => {
  // Each test mutates process.env then re-imports the module to re-run the
  // key check. vi.resetModules ensures we hit getRawKey() with the new env.
  let originalKey: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;

    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("throws when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;
    const fresh = await import("../encryption?missing-key" as string).catch(() => null);
    // Cache-busting via query suffix only works in some loaders; fall back
    // to the cached module + re-trigger via encrypt() — same getRawKey path.
    if (fresh) {
      expect(() => fresh.encrypt("x")).toThrow(/at least 32 characters/);
    } else {
      expect(() => encryptModule.encrypt("x")).toThrow(/at least 32 characters/);
    }
  });

  it("throws when ENCRYPTION_KEY is shorter than 32 characters", () => {
    process.env.ENCRYPTION_KEY = "tooShort";
    expect(() => encryptModule.encrypt("x")).toThrow(/at least 32 characters/);
  });

  it("throws in production when key contains a placeholder fragment", () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "your-32-character-secret-here-padding-padding";
    expect(() => encryptModule.encrypt("x")).toThrow(/placeholder/i);
  });

  it("accepts a placeholder key OUTSIDE production (development/test)", () => {
    process.env.NODE_ENV = "development";
    process.env.ENCRYPTION_KEY = "your-32-character-key-here-padding-pad";
    expect(() => encryptModule.encrypt("x")).not.toThrow();
  });

  it("accepts a real 32+ char key in production", () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = REAL_KEY;
    const ct = encryptModule.encrypt("prod-secret");
    expect(encryptModule.decrypt(ct)).toBe("prod-secret");
  });
});
