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

describe("encrypt / decrypt round-trip (v2 — scrypt KDF)", () => {
  it("recovers the original UTF-8 plaintext", () => {
    const original = "hello, encrypted world";
    const ct = encryptModule.encrypt(original);
    expect(encryptModule.decrypt(ct)).toBe(original);
  });

  it("emits ciphertext with the v2: prefix", () => {
    const ct = encryptModule.encrypt("foo");
    expect(ct.startsWith("v2:")).toBe(true);
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
  function makeV1Ciphertext(plaintext: string, rawKey: string): string {
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
    const v1 = makeV1Ciphertext(original, REAL_KEY);
    expect(v1.startsWith("v2:")).toBe(false);
    expect(encryptModule.decrypt(v1)).toBe(original);
  });

  it("throws on truncated v1 ciphertext (shorter than IV+TAG)", () => {
    const tooShort = Buffer.from("x".repeat(20)).toString("base64");
    expect(() => encryptModule.decrypt(tooShort)).toThrow(/v1 ciphertext too short/);
  });
});

describe("decrypt — v2 invariants and tamper-detection", () => {
  it("throws on truncated v2 ciphertext", () => {
    const tooShort = "v2:" + Buffer.from("x".repeat(20)).toString("base64");
    expect(() => encryptModule.decrypt(tooShort)).toThrow(/v2 ciphertext too short/);
  });

  it("rejects v2 ciphertext with a flipped tag byte (auth fails)", () => {
    const ct = encryptModule.encrypt("tamper-me");
    const raw = Buffer.from(ct.slice(3), "base64");
    // Flip one bit inside the auth tag (bytes 32..47, after salt[0..15] + iv[16..31]).
    raw[32] ^= 0xff;
    const tampered = "v2:" + raw.toString("base64");
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
