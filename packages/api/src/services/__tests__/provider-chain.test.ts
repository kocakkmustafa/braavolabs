/**
 * provider-chain unit tests (E2/T7 — plan §2.2 Karar B).
 *
 *   • classifyProviderError — the plan's classification table:
 *       429 → TRANSIENT · 401/402/403 → FAILOVER · 400 → FATAL
 *   • circuit breaker — 3 failures / 5min window opens, 5min cooldown,
 *     success resets (in-memory, tenant×provider).
 *   • buildTenantProviderChain — D-009-corrected order + privacy rule:
 *       BYOK default → fallbackOrder links → trial (FREE, counted) →
 *       system Anthropic (opt-in only) · OFFLINE_MODE strips cloud links.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-5-20250929",
  OFFLINE_MODE: false,
}));
vi.mock("../../config/env", () => ({ env: envMock }));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = vi.hoisted(() => ({
  aiConfigFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
}));
vi.mock("../../lib/db", () => ({
  prisma: {
    userAIConfig: { findMany: (...a: unknown[]) => db.aiConfigFindMany(...a) },
    tenant: { findUnique: (...a: unknown[]) => db.tenantFindUnique(...a) },
  },
}));

const decryptMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/encryption", () => ({
  decryptForTenant: (...a: unknown[]) => decryptMock(...a),
  encryptForTenant: vi.fn(() => "encrypted"),
}));

const tryConsumeTrialRunMock = vi.hoisted(() => vi.fn());
vi.mock("../trial-llm", () => ({
  tryConsumeTrialRun: (...a: unknown[]) => tryConsumeTrialRunMock(...a),
  commitTrialRun: vi.fn(),
}));

import {
  classifyProviderError,
  isFailoverEligible,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderTripped,
  resetProviderCircuits,
  buildTenantProviderChain,
  listTenantProviderLinks,
} from "../provider-chain";
import { ToolsUnsupportedError } from "../ai-client";

const TENANT = "tenant-chain";

interface RowSpec {
  provider: string;
  model: string;
  key?: string | null;
  isDefault?: boolean;
  fallbackOrder?: number | null;
  allowSystemFallback?: boolean;
  corrupt?: boolean;
  baseUrl?: string | null;
  createdAtDay?: number;
}

function seedRows(rows: RowSpec[], plan = "FREE"): void {
  db.aiConfigFindMany.mockResolvedValue(
    rows.map((r, i) => ({
      id: `row-${i}`,
      tenantId: TENANT,
      provider: r.provider,
      model: r.model,
      encryptedApiKey: r.key == null ? null : `enc:${i}`,
      baseUrl: r.baseUrl ?? null,
      isDefault: r.isDefault ?? false,
      fallbackOrder: r.fallbackOrder ?? null,
      allowSystemFallback: r.allowSystemFallback ?? false,
      createdAt: new Date(2026, 0, r.createdAtDay ?? i + 1),
    })),
  );
  db.tenantFindUnique.mockResolvedValue({ plan });
  decryptMock.mockImplementation((blob: string) => {
    const idx = Number(blob.split(":")[1]);
    const spec = rows[idx];
    if (!spec || spec.corrupt) throw new Error("bad key blob");
    return spec.key;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderCircuits();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
  envMock.OFFLINE_MODE = false;
  tryConsumeTrialRunMock.mockResolvedValue(null);
  seedRows([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Classification table (plan §2.2) ───

describe("classifyProviderError — TRANSIENT / FAILOVER / FATAL", () => {
  it("429 / 5xx / timeout / network → TRANSIENT (same-provider retry class)", () => {
    expect(classifyProviderError(new Error("GROQ API error 429: rate limited"))).toBe("TRANSIENT");
    expect(classifyProviderError(new Error("OPENAI API error 500: internal"))).toBe("TRANSIENT");
    expect(classifyProviderError(new Error("MISTRAL API error 503: overloaded"))).toBe("TRANSIENT");
    expect(classifyProviderError(new Error("ANTHROPIC API error 529: overloaded"))).toBe("TRANSIENT");
    expect(classifyProviderError(new Error("GROQ timeout after 60s. Provider unreachable."))).toBe(
      "TRANSIENT",
    );
    expect(
      classifyProviderError(new Error("OLLAMA unreachable at http://localhost:11434: ECONNREFUSED")),
    ).toBe("TRANSIENT");
  });

  it("401 / 402 / 403 / quota / credit → FAILOVER (next chain link)", () => {
    expect(classifyProviderError(new Error("DEEPSEEK API error 401: invalid api key"))).toBe(
      "FAILOVER",
    );
    expect(
      classifyProviderError(new Error("OPENAI API error 402: insufficient_quota")),
    ).toBe("FAILOVER");
    expect(classifyProviderError(new Error("KIMI API error 403: access terminated"))).toBe(
      "FAILOVER",
    );
    expect(classifyProviderError(new Error("You exceeded your current quota_exceeded"))).toBe(
      "FAILOVER",
    );
    // SDK-style errors carry a numeric .status instead of a message code.
    const sdkErr = Object.assign(new Error("authentication_error"), { status: 401 });
    expect(classifyProviderError(sdkErr)).toBe("FAILOVER");
  });

  it("400-class request errors → FATAL (never chained — same request would fail everywhere)", () => {
    expect(classifyProviderError(new Error("GROQ API error 400: invalid request body"))).toBe(
      "FATAL",
    );
    expect(classifyProviderError(new Error("OPENAI API error 404: model not found"))).toBe("FATAL");
    expect(classifyProviderError(new Error("QWEN API error 422: unprocessable"))).toBe("FATAL");
    expect(
      classifyProviderError(new ToolsUnsupportedError("OLLAMA", "gemma3:4b", "no tools")),
    ).toBe("FATAL");
  });

  it("unknown errors default to TRANSIENT (transport retries already exhausted; chain is bounded)", () => {
    expect(classifyProviderError(new Error("something odd happened"))).toBe("TRANSIENT");
  });

  it("isFailoverEligible: everything except FATAL advances the chain", () => {
    expect(isFailoverEligible("TRANSIENT")).toBe(true);
    expect(isFailoverEligible("FAILOVER")).toBe(true);
    expect(isFailoverEligible("FATAL")).toBe(false);
  });
});

// ─── Circuit breaker ───

describe("circuit breaker — 3 failures / 5min → open, 5min cooldown", () => {
  it("opens after the 3rd failure inside the window and closes after the cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T10:00:00Z"));

    recordProviderFailure(TENANT, "GROQ");
    recordProviderFailure(TENANT, "GROQ");
    expect(isProviderTripped(TENANT, "GROQ")).toBe(false);

    recordProviderFailure(TENANT, "GROQ");
    expect(isProviderTripped(TENANT, "GROQ")).toBe(true);

    // Cooldown expiry re-closes the circuit.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(isProviderTripped(TENANT, "GROQ")).toBe(false);
  });

  it("failures outside the 5-minute window don't accumulate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T10:00:00Z"));

    recordProviderFailure(TENANT, "GROQ");
    vi.advanceTimersByTime(6 * 60_000); // first failure ages out
    recordProviderFailure(TENANT, "GROQ");
    recordProviderFailure(TENANT, "GROQ");
    expect(isProviderTripped(TENANT, "GROQ")).toBe(false);
  });

  it("a success resets the failure count", () => {
    recordProviderFailure(TENANT, "GROQ");
    recordProviderFailure(TENANT, "GROQ");
    recordProviderSuccess(TENANT, "GROQ");
    recordProviderFailure(TENANT, "GROQ");
    recordProviderFailure(TENANT, "GROQ");
    expect(isProviderTripped(TENANT, "GROQ")).toBe(false);
  });

  it("state is keyed per tenant×provider — no cross-tenant blast radius", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure(TENANT, "GROQ");
    expect(isProviderTripped(TENANT, "GROQ")).toBe(true);
    expect(isProviderTripped("other-tenant", "GROQ")).toBe(false);
    expect(isProviderTripped(TENANT, "OPENAI")).toBe(false);
  });
});

// ─── Chain building (D-009 order + privacy rule) ───

describe("buildTenantProviderChain — order + privacy", () => {
  it("orders links: BYOK default → fallbackOrder asc; keys decrypted per row", async () => {
    seedRows([
      { provider: "OPENAI", model: "gpt-4o", key: "sk-oai", fallbackOrder: 2 },
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true },
      { provider: "GROQ", model: "llama-3.3-70b-versatile", key: "gsk-1", fallbackOrder: 1 },
    ]);

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => [l.provider, l.source])).toEqual([
      ["DEEPSEEK", "byok-default"],
      ["GROQ", "byok-fallback"],
      ["OPENAI", "byok-fallback"],
    ]);
    expect(chain[0]!.config.apiKey).toBe("sk-ds");
    expect(chain[1]!.config.apiKey).toBe("gsk-1");
  });

  it("rows WITHOUT fallbackOrder are stored keys, not chain members (failover default-OFF)", async () => {
    seedRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true },
      { provider: "GROQ", model: "llama-3.3-70b-versatile", key: "gsk-1", fallbackOrder: null },
    ]);

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain).toHaveLength(1);
    expect(chain[0]!.provider).toBe("DEEPSEEK");
  });

  it("PRIVACY: BYOK tenant with allowSystemFallback=false gets NO trial and NO system link", async () => {
    seedRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true },
    ]);
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
      remainingBefore: 3,
      remainingAfter: 2,
    });

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => l.source)).toEqual(["byok-default"]);
    // Trial eligibility isn't even consulted without the opt-in.
    expect(tryConsumeTrialRunMock).not.toHaveBeenCalled();
  });

  it("opt-in (allowSystemFallback=true on the default row) appends trial then system", async () => {
    seedRows([
      {
        provider: "DEEPSEEK",
        model: "deepseek-chat",
        key: "sk-ds",
        isDefault: true,
        allowSystemFallback: true,
      },
    ]);
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
      remainingBefore: 3,
      remainingAfter: 2,
    });

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => l.source)).toEqual(["byok-default", "trial", "system"]);
    expect(chain[2]!.config).toMatchObject({
      provider: "ANTHROPIC",
      apiKey: "sk-ant-system-key",
    });
  });

  it("D-009: BYOK-less FREE tenant → trial only, never the system key", async () => {
    seedRows([], "FREE");
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
      remainingBefore: 1,
      remainingAfter: 0,
    });

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => l.source)).toEqual(["trial"]);
  });

  it("D-009: BYOK-less FREE tenant with a spent trial gets an EMPTY chain", async () => {
    seedRows([], "FREE");
    tryConsumeTrialRunMock.mockResolvedValue(null);

    expect(await buildTenantProviderChain(TENANT)).toEqual([]);
  });

  it("BYOK-less PAID tenant keeps the system entry (deliberate — see module docs)", async () => {
    seedRows([], "BUSINESS");

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => l.source)).toEqual(["system"]);
  });

  it("a MISSING tenant row is fail-closed (treated as FREE — no system key)", async () => {
    seedRows([]);
    db.tenantFindUnique.mockResolvedValue(null);

    expect(await buildTenantProviderChain(TENANT)).toEqual([]);
  });

  it("cloud rows whose key won't decrypt are skipped (D-002 reasoning), local rows run keyless", async () => {
    seedRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true, corrupt: true },
      { provider: "OLLAMA", model: "gemma3:4b", key: null, fallbackOrder: 1, baseUrl: "http://localhost:11434/v1" },
    ]);

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => [l.provider, l.source])).toEqual([["OLLAMA", "byok-fallback"]]);
    expect(chain[0]!.config).toMatchObject({ apiKey: "", baseUrl: "http://localhost:11434/v1" });
  });

  it("OFFLINE_MODE strips every cloud link — BYOK cloud rows, trial and system included", async () => {
    envMock.OFFLINE_MODE = true;
    seedRows([
      {
        provider: "DEEPSEEK",
        model: "deepseek-chat",
        key: "sk-ds",
        isDefault: true,
        allowSystemFallback: true,
      },
      { provider: "OLLAMA", model: "gemma3:4b", key: null, fallbackOrder: 1 },
    ]);

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain.map((l) => l.provider)).toEqual(["OLLAMA"]);
    expect(tryConsumeTrialRunMock).not.toHaveBeenCalled();
  });

  it("legacy single-row tenant without isDefault resolves by createdAt (getTenantAIConfig parity)", async () => {
    seedRows([
      { provider: "GROQ", model: "llama-3.3-70b-versatile", key: "gsk-old", createdAtDay: 1 },
      { provider: "OPENAI", model: "gpt-4o", key: "sk-new", createdAtDay: 2 },
    ]);

    const chain = await buildTenantProviderChain(TENANT);

    expect(chain[0]).toMatchObject({ provider: "GROQ", source: "byok-default" });
  });
});

// ─── Compare-mode candidate listing (E2/T8 — plan §2.5) ───

describe("listTenantProviderLinks — configured providers as compare candidates", () => {
  it("returns ALL usable rows (fallbackOrder=NULL included) in default → fallbackOrder → createdAt order", async () => {
    seedRows([
      { provider: "OPENAI", model: "gpt-4o", key: "sk-oai", fallbackOrder: null, createdAtDay: 4 },
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true, createdAtDay: 3 },
      { provider: "GROQ", model: "llama-3.3-70b-versatile", key: "gsk-1", fallbackOrder: 1, createdAtDay: 2 },
      { provider: "MISTRAL", model: "mistral-large-latest", key: "sk-mist", fallbackOrder: 2, createdAtDay: 1 },
    ]);

    const links = await listTenantProviderLinks(TENANT);

    expect(links.map((l) => [l.provider, l.source])).toEqual([
      ["DEEPSEEK", "byok-default"],
      ["GROQ", "byok-fallback"],
      ["MISTRAL", "byok-fallback"],
      ["OPENAI", "byok-fallback"], // stored key: candidate, even if not a chain member
    ]);
    expect(links[0]!.config.apiKey).toBe("sk-ds");
    expect(links[3]!.config.apiKey).toBe("sk-oai");
  });

  it("never contains trial/system links (tenant's own keys ONLY) and skips undecryptable cloud rows", async () => {
    seedRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true, corrupt: true, allowSystemFallback: true },
      { provider: "OLLAMA", model: "gemma3:4b", key: null, baseUrl: "http://localhost:11434/v1" },
    ]);
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
      remainingBefore: 3,
      remainingAfter: 2,
    });

    const links = await listTenantProviderLinks(TENANT);

    expect(links.map((l) => l.provider)).toEqual(["OLLAMA"]); // corrupt DEEPSEEK dropped
    expect(tryConsumeTrialRunMock).not.toHaveBeenCalled(); // no trial leg in compare mode
  });

  it("OFFLINE_MODE strips cloud candidates, keeps local ones", async () => {
    envMock.OFFLINE_MODE = true;
    seedRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", key: "sk-ds", isDefault: true },
      { provider: "OLLAMA", model: "gemma3:4b", key: null },
    ]);

    const links = await listTenantProviderLinks(TENANT);

    expect(links.map((l) => l.provider)).toEqual(["OLLAMA"]);
  });
});
