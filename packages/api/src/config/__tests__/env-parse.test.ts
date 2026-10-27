import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BRV-27 (zod 3 → 4): env.ts validates the whole process env at import, so
 * a schema that parses differently stops production boot or flips a safety
 * flag silently. Pins the string→bool flags, the "" → undefined preprocess
 * fields and the coerced numbers across the zod major.
 */
const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5399/synthetic",
  JWT_SECRET: "synthetic-jwt-secret-at-least-32-characters-long",
  ENCRYPTION_KEY: "synthetic-encryption-key-at-least-32-characters",
};

async function loadEnv(extra: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE, ...extra })) vi.stubEnv(k, v);
  return (await import("../env")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env parse (zod 4)", () => {
  it("keeps the explicit string→bool flags: only 'true' enables, fail-closed defaults on", async () => {
    vi.stubEnv("BYPASS_BILLING", undefined as unknown as string);
    vi.stubEnv("TENANT_CONTEXT_FAIL_CLOSED", undefined as unknown as string);
    let env = await loadEnv();
    expect(env.BYPASS_BILLING).toBe(false);
    expect(env.TENANT_CONTEXT_FAIL_CLOSED).toBe(true);
    env = await loadEnv({ BYPASS_BILLING: "false", TENANT_CONTEXT_FAIL_CLOSED: "0" });
    expect(env.BYPASS_BILLING).toBe(false);
    expect(env.TENANT_CONTEXT_FAIL_CLOSED).toBe(true);
    env = await loadEnv({ BYPASS_BILLING: "true", TENANT_CONTEXT_FAIL_CLOSED: "false" });
    expect(env.BYPASS_BILLING).toBe(true);
    expect(env.TENANT_CONTEXT_FAIL_CLOSED).toBe(false);
  });

  it("treats empty optional URLs, emails and rates as unset", async () => {
    const env = await loadEnv({
      SENTRY_DSN: "",
      GOOGLE_REDIRECT_URI: "",
      SENTRY_TRACES_SAMPLE_RATE: "",
      GOOGLE_PUBSUB_SA_EMAIL: "  ",
    });
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.GOOGLE_REDIRECT_URI).toBeUndefined();
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBeUndefined();
    expect(env.GOOGLE_PUBSUB_SA_EMAIL).toBeUndefined();
  });

  it("coerces numbers and applies defaults", async () => {
    let env = await loadEnv();
    expect(env.API_PORT).toBe(8080);
    expect(env.GROQ_TRIAL_MODEL).toBe("llama-3.3-70b-versatile");
    env = await loadEnv({ API_PORT: "5360", SENTRY_TRACES_SAMPLE_RATE: "0.2", TRUST_PROXY_HOPS: "2" });
    expect(env.API_PORT).toBe(5360);
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.2);
    expect(env.TRUST_PROXY_HOPS).toBe(2);
  });

  it("still rejects a malformed URL and an out-of-range rate", async () => {
    await expect(loadEnv({ SENTRY_DSN: "not a url" })).rejects.toThrow();
    await expect(loadEnv({ SENTRY_TRACES_SAMPLE_RATE: "1.5" })).rejects.toThrow();
  });
});
