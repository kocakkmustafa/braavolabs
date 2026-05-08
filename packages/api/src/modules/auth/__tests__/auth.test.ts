/**
 * Auth schema tests — guards the validation contract between the client
 * form and the API router. Drift between the two is the #1 cause of
 * "Validation failed" responses reaching the user (see ISS-014 in
 * master-issues.json — the Tone-pricing-page launch slip we caught
 * mid-cycle was exactly this drift class).
 *
 * Tests are pure (no Prisma / Redis / JWT side-effects), run as part of
 * the standard `pnpm test` Vitest suite, and don't require any env seed
 * beyond what vitest.config.ts already provides.
 */

import { describe, it, expect } from "vitest";
import { registerSchema, loginSchema, forgotSchema, resetSchema } from "../auth.router";

// Helpers for compactness — Zod throws on .parse failure, returns on
// .safeParse, and we want both shapes covered.
const ok = (s: any, input: unknown) => s.safeParse(input).success;
const err = (s: any, input: unknown) => {
  const r = s.safeParse(input);
  return r.success ? null : r.error.issues.map((i: any) => i.path.join(".") + ":" + i.code).join(",");
};

describe("auth.registerSchema", () => {
  const valid = {
    email: "jane@example.com",
    password: "Strong1Pass",
    name: "Jane Smith",
    tenantName: "Acme",
  };

  it("accepts a fully valid payload", () => {
    expect(ok(registerSchema, valid)).toBe(true);
  });

  it("accepts a valid payload with optional ref code", () => {
    expect(ok(registerSchema, { ...valid, ref: "FRIEND-2026" })).toBe(true);
  });

  it("rejects malformed email", () => {
    expect(err(registerSchema, { ...valid, email: "not-an-email" })).toContain("email");
  });

  it("rejects password shorter than 8 chars", () => {
    expect(err(registerSchema, { ...valid, password: "Short1" })).toContain("password");
  });

  it("rejects password without uppercase", () => {
    expect(err(registerSchema, { ...valid, password: "alllower1" })).toContain("password");
  });

  it("rejects password without lowercase", () => {
    expect(err(registerSchema, { ...valid, password: "ALLUPPER1" })).toContain("password");
  });

  it("rejects password without number", () => {
    expect(err(registerSchema, { ...valid, password: "NoDigitsHere" })).toContain("password");
  });

  it("accepts password with special chars (special chars NOT required by regex)", () => {
    // Mirrors the deliberate decision in auth.service: the strength
    // meter rewards specials but the validator does not require them,
    // so client + server must agree.
    expect(ok(registerSchema, { ...valid, password: "Strong1!@" })).toBe(true);
  });

  it("rejects empty name", () => {
    expect(err(registerSchema, { ...valid, name: "" })).toContain("name");
  });

  it("rejects empty tenant name", () => {
    expect(err(registerSchema, { ...valid, tenantName: "" })).toContain("tenantName");
  });

  it("rejects extra fields silently dropped (Zod default — strict not used)", () => {
    // Zod by default strips unknown keys; this documents the contract.
    const parsed = registerSchema.safeParse({ ...valid, role: "ADMIN" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as any).role).toBeUndefined();
  });
});

describe("auth.loginSchema", () => {
  it("accepts valid email + any non-empty password", () => {
    expect(ok(loginSchema, { email: "j@e.com", password: "x" })).toBe(true);
  });

  it("rejects malformed email", () => {
    expect(err(loginSchema, { email: "no", password: "x" })).toContain("email");
  });

  it("rejects empty password", () => {
    // Login schema doesn't enforce strength rules — only "must be set"
    // — because legacy users could have weaker passwords from before
    // the regex was added. Brute-force is gated by the lockout middleware.
    expect(err(loginSchema, { email: "j@e.com", password: "" })).toContain("password");
  });
});

describe("auth.forgotSchema", () => {
  it("accepts valid email", () => {
    expect(ok(forgotSchema, { email: "user@example.com" })).toBe(true);
  });

  it("rejects malformed email", () => {
    expect(err(forgotSchema, { email: "garbage" })).toContain("email");
  });
});

describe("auth.resetSchema", () => {
  it("accepts non-empty token + strong password", () => {
    expect(ok(resetSchema, { token: "abc123", password: "Reset1Pass" })).toBe(true);
  });

  it("rejects empty token", () => {
    expect(err(resetSchema, { token: "", password: "Reset1Pass" })).toContain("token");
  });

  it("enforces same password regex as registerSchema", () => {
    // If these two ever drift, the user can register with one rule and
    // reset with another — confusing UX.
    expect(err(resetSchema, { token: "x", password: "weakpass" })).toContain("password");
  });
});
