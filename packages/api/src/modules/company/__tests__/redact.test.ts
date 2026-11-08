/**
 * BRA-SEC-01 — behaviour contract of the Company.config response filter.
 */
import { describe, it, expect } from "vitest";
import { redactCompanyConfig, toPublicCompany, REDACTED, PUBLIC_CONFIG_KEYS } from "../redact";

const SECRET = "test-secret-value";

describe("redactCompanyConfig", () => {
  it("drops webhookSecret and reports webhookSecretSet instead", () => {
    const out = redactCompanyConfig({ niche: "saas", webhookSecret: SECRET });
    expect(out).toEqual({ niche: "saas", webhookSecretSet: true });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("does not set webhookSecretSet when no secret is stored", () => {
    expect(redactCompanyConfig({ niche: "x" })).toEqual({ niche: "x" });
    expect(redactCompanyConfig({ webhookSecret: "" })).toEqual({});
  });

  it("allowlist: unknown top-level keys are dropped", () => {
    const out = redactCompanyConfig({ niche: "a", internalFlag: true, apiKey: SECRET, somethingNew: 1 });
    expect(out).toEqual({ niche: "a" });
  });

  it("keeps every allowlisted key as-is when no secrets are nested", () => {
    const cfg: Record<string, unknown> = {};
    for (const k of PUBLIC_CONFIG_KEYS) cfg[k] = `v-${k}`;
    expect(redactCompanyConfig(cfg)).toEqual(cfg);
  });

  it("masks secret-named keys nested inside allowed values (objects)", () => {
    const out = redactCompanyConfig({
      budget: { monthly: 100, stripeSecretKey: SECRET, nested: { Password: SECRET, ok: 1 } },
    });
    expect(out).toEqual({
      budget: { monthly: 100, stripeSecretKey: REDACTED, nested: { Password: REDACTED, ok: 1 } },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("masks secret-named keys inside objects within arrays", () => {
    const out = redactCompanyConfig({
      channels: ["tiktok", { name: "x", accessToken: SECRET, credentials: { user: "u" } }],
    });
    expect(out).toEqual({ channels: ["tiktok", { name: "x", accessToken: REDACTED, credentials: REDACTED }] });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("matches key names case-insensitively", () => {
    const out = redactCompanyConfig({ icp: { API_KEY: SECRET, Token: SECRET, CLIENT_SECRET: SECRET } });
    expect(out).toEqual({ icp: { API_KEY: REDACTED, Token: REDACTED, CLIENT_SECRET: REDACTED } });
  });

  it("null / undefined / non-object / array config → {}", () => {
    expect(redactCompanyConfig(null)).toEqual({});
    expect(redactCompanyConfig(undefined)).toEqual({});
    expect(redactCompanyConfig("x")).toEqual({});
    expect(redactCompanyConfig(5)).toEqual({});
    expect(redactCompanyConfig([{ webhookSecret: SECRET }])).toEqual({});
  });

  it("does not mutate its input", () => {
    const input = { niche: "a", webhookSecret: SECRET, budget: { apiKey: SECRET } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactCompanyConfig(input);
    expect(input).toEqual(snapshot);
  });
});

describe("toPublicCompany", () => {
  it("redacts config and preserves every other field and relation", () => {
    const row = { id: "c1", name: "N", config: { niche: "a", webhookSecret: SECRET }, agents: [{ id: "a1" }] };
    const out = toPublicCompany(row);
    expect(out).toEqual({ id: "c1", name: "N", config: { niche: "a", webhookSecretSet: true }, agents: [{ id: "a1" }] });
    expect(row.config.webhookSecret).toBe(SECRET);
  });

  it("leaves a row without a config key unchanged in shape", () => {
    expect(Object.keys(toPublicCompany({ id: "c1", tenantId: "t" }))).toEqual(["id", "tenantId"]);
  });

  it("null config column → config {}", () => {
    expect(toPublicCompany({ id: "c1", config: null }).config).toEqual({});
  });

  it("passes null / undefined through", () => {
    expect(toPublicCompany(null)).toBeNull();
    expect(toPublicCompany(undefined)).toBeUndefined();
  });
});
