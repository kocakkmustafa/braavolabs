/**
 * E2/T7 — provider chain resolution + turn-boundary failover (D-009).
 *
 * KIRMIZI-YEŞİL evidence for D-009: the tests in the "D-009" block were
 * written FIRST against the pre-T7 code and FAIL there, documenting the
 * live cost bleed — a FREE tenant with no BYOK config runs a full
 * tool-use loop on the UNCOUNTED system Anthropic key because
 * getTenantAIConfig returns the system config before the trial path is
 * ever consulted (ai-client.ts system fallback beats claude.ts's trial
 * catch — plan A2). After the T7 chain re-ordering they pass:
 *   BYOK (default → fallbackOrder) → trial Groq (counted) → system
 *   Anthropic ONLY on opt-in (allowSystemFallback).
 *
 * Mocked: prisma, encryption, trial-llm, chatCompletion (no network).
 * REAL: provider-chain (chain building, classification, circuit breaker),
 * resolveModelForProvider, the unified loop itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  LLM_PROVIDER: "api" as string | undefined,
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-5-20250929",
  OFFLINE_MODE: false,
  NATIVE_TOOLUSE_PROVIDERS: undefined as string | undefined,
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = vi.hoisted(() => ({
  aiConfigFindFirst: vi.fn(),
  aiConfigFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  activityLogCreate: vi.fn(),
  steeringFindMany: vi.fn(),
  steeringUpdateMany: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findFirst: (...a: unknown[]) => db.aiConfigFindFirst(...a),
      findMany: (...a: unknown[]) => db.aiConfigFindMany(...a),
    },
    tenant: { findUnique: (...a: unknown[]) => db.tenantFindUnique(...a) },
    activityLog: { create: (...a: unknown[]) => db.activityLogCreate(...a) },
    steeringMessage: {
      findMany: (...a: unknown[]) => db.steeringFindMany(...a),
      updateMany: (...a: unknown[]) => db.steeringUpdateMany(...a),
    },
  },
}));

const publishRunEventMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/runEvents", () => ({
  publishRunEvent: (...a: unknown[]) => publishRunEventMock(...a),
}));

const decryptMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/encryption", () => ({
  decryptForTenant: (...a: unknown[]) => decryptMock(...a),
  encryptForTenant: vi.fn(() => "encrypted"),
}));

vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: async () => {},
  SsrfError: class SsrfError extends Error {},
}));

vi.mock("../registry", () => ({
  getTool: (name: string) =>
    name === "get_time"
      ? {
          name: "get_time",
          description: "Return the current time for a timezone",
          inputSchema: {
            type: "object",
            properties: { timezone: { type: "string" } },
            required: ["timezone"],
          },
          handler: async () => ({ time: "now" }),
        }
      : undefined,
}));

const executeToolMock = vi.hoisted(() => vi.fn());
vi.mock("../tool-executor", () => ({
  executeTool: (...a: unknown[]) => executeToolMock(...a),
}));

vi.mock("../claude-local", () => ({ runLocalAgentLoop: vi.fn() }));

const tryConsumeTrialRunMock = vi.hoisted(() => vi.fn());
const commitTrialRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/trial-llm", () => ({
  tryConsumeTrialRun: (...a: unknown[]) => tryConsumeTrialRunMock(...a),
  commitTrialRun: (...a: unknown[]) => commitTrialRunMock(...a),
}));

// ai-client — ONLY chatCompletion is mocked; getTenantAIConfig, catalogues
// and model resolution stay REAL so the chain resolution under test is the
// production one.
const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
  };
});

import { runAgentLoop, type AgentGovContext } from "../claude";
import type { AIClientConfig, ChatCompletionResult } from "../../../services/ai-client";

const TENANT = "tenant-t7";
const SYSTEM_KEY = "sk-ant-system-key";
const TRIAL_KEY = "gsk-trial-holding";

const GOV: AgentGovContext = {
  tenantId: TENANT,
  companyId: "co-1",
  runId: "run-t7",
  runStepId: "rs-1",
};

function completion(partial: Partial<ChatCompletionResult>): ChatCompletionResult {
  return {
    content: "done",
    inputTokens: 10,
    outputTokens: 5,
    model: "llama-3.3-70b-versatile",
    provider: "GROQ",
    stopReason: "stop",
    ...partial,
  };
}

interface RowSpec {
  provider: string;
  model: string;
  apiKey?: string | null; // plaintext the decrypt mock returns; null = keyless row
  baseUrl?: string | null;
  isDefault?: boolean;
  fallbackOrder?: number | null;
  allowSystemFallback?: boolean;
  corruptKey?: boolean; // decryptForTenant throws for this row
}

/** Seed the tenant's UserAIConfig rows for BOTH resolution paths (legacy
 * findFirst default-row semantics and the T7 findMany chain builder). */
function seedTenantRows(rows: RowSpec[], plan: string = "FREE"): void {
  const dbRows = rows.map((r, i) => ({
    id: `cfg-${i}`,
    tenantId: TENANT,
    provider: r.provider,
    model: r.model,
    encryptedApiKey: r.apiKey == null ? null : `enc:${r.apiKey}`,
    baseUrl: r.baseUrl ?? null,
    isDefault: r.isDefault ?? false,
    fallbackOrder: r.fallbackOrder ?? null,
    allowSystemFallback: r.allowSystemFallback ?? false,
    createdAt: new Date(2026, 0, 1 + i),
  }));
  const sorted = [...dbRows].sort((a, b) =>
    a.isDefault === b.isDefault
      ? a.createdAt.getTime() - b.createdAt.getTime()
      : a.isDefault
        ? -1
        : 1,
  );
  db.aiConfigFindFirst.mockResolvedValue(sorted[0] ?? null);
  db.aiConfigFindMany.mockResolvedValue(dbRows);
  db.tenantFindUnique.mockResolvedValue({ plan });
  decryptMock.mockImplementation((blob: string) => {
    const spec = rows.find((r) => r.apiKey != null && `enc:${r.apiKey}` === blob);
    if (!spec || spec.corruptKey) throw new Error("decrypt failed");
    return spec.apiKey;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  envMock.ANTHROPIC_API_KEY = SYSTEM_KEY;
  envMock.OFFLINE_MODE = false;
  db.steeringFindMany.mockResolvedValue([]);
  db.steeringUpdateMany.mockResolvedValue({ count: 0 });
  db.activityLogCreate.mockResolvedValue({});
  executeToolMock.mockResolvedValue({ status: "SUCCESS", output: { ok: true }, durationMs: 2 });
  tryConsumeTrialRunMock.mockResolvedValue(null);
  commitTrialRunMock.mockResolvedValue(undefined);
  seedTenantRows([]);
  // Circuit-breaker state is module-level — reset between tests once the
  // T7 module exists (guarded import so the RED run predates the file).
  try {
    const chain = await import("../../../services/provider-chain");
    chain.resetProviderCircuits();
  } catch {
    /* pre-T7 red run — module not written yet */
  }
});

/** Every provider config chatCompletion was dialed with, in call order. */
function dialedConfigs(): AIClientConfig[] {
  return chatCompletionMock.mock.calls.map((c) => c[0] as AIClientConfig);
}

// ─────────────────────────────────────────────────────────────────────────
// D-009 — the chain re-ordering (KIRMIZI first: these fail pre-T7)
// ─────────────────────────────────────────────────────────────────────────

describe("D-009 — BYOK-less FREE tenant must NEVER burn the uncounted system key", () => {
  it("routes through counted trial-Groq (BYOK → trial → opt-in system order)", async () => {
    seedTenantRows([], "FREE"); // no BYOK rows
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: TRIAL_KEY },
      remainingBefore: 3,
      remainingAfter: 2,
    });
    chatCompletionMock.mockResolvedValue(completion({ content: "trial answer" }));

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: ["get_time"],
      tenantId: TENANT,
      govContext: GOV,
    });

    // The run went to the TRIAL Groq key — counted — not the system wallet.
    expect(dialedConfigs()[0]).toMatchObject({ provider: "GROQ", apiKey: TRIAL_KEY });
    expect(dialedConfigs().every((c) => c.apiKey !== SYSTEM_KEY)).toBe(true);
    // Trial counter committed after success (run-based counter).
    expect(commitTrialRunMock).toHaveBeenCalledExactlyOnceWith(TENANT);
    expect(result.finalContent).toBe("trial answer");
  });

  it("trial exhausted → explicit error, NOT a silent fall-through to the system key", async () => {
    seedTenantRows([], "FREE");
    tryConsumeTrialRunMock.mockResolvedValue(null); // counter spent / trial dormant

    await expect(
      runAgentLoop({
        systemPrompt: "sys",
        userMessage: "go",
        toolNames: [],
        tenantId: TENANT,
        govContext: GOV,
      }),
    ).rejects.toThrow(/No AI provider configured/);

    // The bleed: pre-T7 this ran a full loop on the system Anthropic key.
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(commitTrialRunMock).not.toHaveBeenCalled();
  });

  it("trial counter is NOT committed when the trial run fails (slot refunded)", async () => {
    seedTenantRows([], "FREE");
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: TRIAL_KEY },
      remainingBefore: 1,
      remainingAfter: 0,
    });
    chatCompletionMock.mockRejectedValue(new Error("GROQ API error 400: bad request"));

    await expect(
      runAgentLoop({
        systemPrompt: "sys",
        userMessage: "go",
        toolNames: [],
        tenantId: TENANT,
        govContext: GOV,
      }),
    ).rejects.toThrow(/400/);

    expect(commitTrialRunMock).not.toHaveBeenCalled();
    expect(dialedConfigs().every((c) => c.apiKey !== SYSTEM_KEY)).toBe(true);
  });

  it("BYOK-less PAID tenant keeps the system entry path (deliberate: the D-009 bleed was FREE tenants)", async () => {
    seedTenantRows([], "PRO");
    chatCompletionMock.mockResolvedValue(
      completion({ content: "paid", provider: "ANTHROPIC", model: "claude-sonnet-4-5-20250929" }),
    );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: TENANT,
      govContext: GOV,
    });

    expect(dialedConfigs()[0]).toMatchObject({ provider: "ANTHROPIC", apiKey: SYSTEM_KEY });
    // Paid tenants never draw from the trial pool.
    expect(commitTrialRunMock).not.toHaveBeenCalled();
    expect(result.finalContent).toBe("paid");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// D-009 second leg — loop errors must surface (the un-awaited `return`
// inside try{} used to bypass the catch, so no failover ever happened)
// ─────────────────────────────────────────────────────────────────────────

describe("D-009 — loop errors surface and are handled (await fix)", () => {
  it("a FATAL provider error on a single-link chain rejects cleanly and never re-routes to the system key", async () => {
    seedTenantRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-deepseek", isDefault: true },
    ]);
    chatCompletionMock.mockRejectedValue(
      new Error("DEEPSEEK API error 400: invalid request body"),
    );

    await expect(
      runAgentLoop({
        systemPrompt: "sys",
        userMessage: "go",
        toolNames: [],
        tenantId: TENANT,
        govContext: GOV,
      }),
    ).rejects.toThrow(/DEEPSEEK API error 400/);

    // Exactly one provider dialed — no silent retry on another wallet.
    expect(dialedConfigs()).toHaveLength(1);
    expect(dialedConfigs()[0]!.provider).toBe("DEEPSEEK");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Turn-boundary failover (plan §2.2 Karar B — K2 evidence, mocked wire)
// ─────────────────────────────────────────────────────────────────────────

describe("turn-boundary failover — canonical transcript moves to the next link", () => {
  it("provider A dies with retry-exhausted 429s → provider B takes over MID-RUN with the full transcript", async () => {
    seedTenantRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds", isDefault: true },
      {
        provider: "GROQ",
        model: "llama-3.3-70b-versatile",
        apiKey: "gsk-fb",
        fallbackOrder: 1,
      },
    ]);
    // Turn 1 on DEEPSEEK succeeds WITH a tool call; turn 2 on DEEPSEEK dies
    // with a (transport-retry-exhausted) 429; GROQ finishes the run.
    let deepseekCalls = 0;
    chatCompletionMock.mockImplementation(async (cfg: AIClientConfig) => {
      if (cfg.provider === "DEEPSEEK") {
        deepseekCalls++;
        if (deepseekCalls === 1) {
          return completion({
            content: "checking",
            provider: "DEEPSEEK",
            model: "deepseek-chat",
            toolCalls: [{ id: "c1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' }],
            stopReason: "tool_calls",
          });
        }
        throw new Error("DEEPSEEK API error 429: rate limited");
      }
      return completion({ content: "groq finished it", provider: "GROQ" });
    });
    executeToolMock.mockResolvedValue({ status: "SUCCESS", output: { time: "14:00" }, durationMs: 2 });

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "what time is it?",
      toolNames: ["get_time"],
      tenantId: TENANT,
      govContext: GOV,
    });

    // Run COMPLETED on the fallback link.
    expect(result.finalContent).toBe("groq finished it");
    expect(result.provider).toBe("GROQ");
    expect(result.servedBy).toBe("byok-fallback");

    // The canonical transcript travelled: GROQ received the SAME turn-2
    // transcript DEEPSEEK died on — assistant tool call + tool result intact.
    const groqCall = chatCompletionMock.mock.calls.find(
      (c) => (c[0] as AIClientConfig).provider === "GROQ",
    )!;
    expect(groqCall[2]).toEqual([
      { role: "user", content: "what time is it?" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' }],
      },
      { role: "tool", toolCallId: "c1", content: JSON.stringify({ time: "14:00" }) },
    ]);
    // Model hierarchy re-resolved against the NEW provider (tenant row model).
    expect((groqCall[0] as AIClientConfig).model).toBe("llama-3.3-70b-versatile");

    // Live visibility: PROVIDER_FAILOVER on the run stream (SSE)…
    expect(publishRunEventMock).toHaveBeenCalledWith(
      GOV.runId,
      expect.objectContaining({
        type: "PROVIDER_FAILOVER",
        from: "DEEPSEEK",
        to: "GROQ",
        stepId: GOV.runStepId,
        reason: expect.stringContaining("429"),
      }),
    );
    // …and the DURABLE audit copy in activity_log (run events are Redis-only).
    expect(db.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        actor: "system",
        action: "run.provider_failover",
        resource: "run",
        resourceId: GOV.runId,
        details: expect.objectContaining({ from: "DEEPSEEK", to: "GROQ" }),
      }),
    });
  });

  it("FATAL (400) never advances the chain — the fallback link is not dialed on the failing wallet's error", async () => {
    seedTenantRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds", isDefault: true },
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-fb", fallbackOrder: 1 },
    ]);
    chatCompletionMock.mockRejectedValue(new Error("DEEPSEEK API error 400: invalid request"));

    await expect(
      runAgentLoop({
        systemPrompt: "sys",
        userMessage: "go",
        toolNames: [],
        tenantId: TENANT,
        govContext: GOV,
      }),
    ).rejects.toThrow(/400/);

    expect(dialedConfigs().map((c) => c.provider)).toEqual(["DEEPSEEK"]);
    expect(publishRunEventMock).not.toHaveBeenCalledWith(
      GOV.runId,
      expect.objectContaining({ type: "PROVIDER_FAILOVER" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Privacy rule (plan §2.2 — binding): only the tenant's OWN providers
// ─────────────────────────────────────────────────────────────────────────

describe("privacy rule — allowSystemFallback gates the trial/system tail", () => {
  it("allowSystemFallback=false → chain exhaustion is an ERROR; the system key is NEVER dialed", async () => {
    seedTenantRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds", isDefault: true },
      // No fallbackOrder rows, opt-in false (default).
    ]);
    chatCompletionMock.mockRejectedValue(new Error("DEEPSEEK API error 401: invalid api key"));

    await expect(
      runAgentLoop({
        systemPrompt: "sys",
        userMessage: "go",
        toolNames: [],
        tenantId: TENANT,
        govContext: GOV,
      }),
    ).rejects.toThrow(/401/);

    expect(dialedConfigs().map((c) => c.provider)).toEqual(["DEEPSEEK"]);
    expect(dialedConfigs().every((c) => c.apiKey !== SYSTEM_KEY)).toBe(true);
  });

  it("allowSystemFallback=true → the system Anthropic link takes over after the tenant chain dies", async () => {
    seedTenantRows(
      [
        {
          provider: "DEEPSEEK",
          model: "deepseek-chat",
          apiKey: "sk-ds",
          isDefault: true,
          allowSystemFallback: true,
        },
      ],
      "PRO",
    );
    chatCompletionMock.mockImplementation(async (cfg: AIClientConfig) => {
      if (cfg.provider === "DEEPSEEK") throw new Error("DEEPSEEK API error 401: invalid api key");
      return completion({ content: "system served", provider: "ANTHROPIC", model: "claude-sonnet-4-5-20250929" });
    });

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: TENANT,
      govContext: GOV,
    });

    expect(result.finalContent).toBe("system served");
    expect(result.servedBy).toBe("system");
    expect(dialedConfigs().map((c) => c.provider)).toEqual(["DEEPSEEK", "ANTHROPIC"]);
    expect(publishRunEventMock).toHaveBeenCalledWith(
      GOV.runId,
      expect.objectContaining({ type: "PROVIDER_FAILOVER", from: "DEEPSEEK", to: "ANTHROPIC" }),
    );
  });

  it("a failed-over trial link does NOT burn the trial slot (counter stays refunded)", async () => {
    seedTenantRows(
      [
        {
          provider: "DEEPSEEK",
          model: "deepseek-chat",
          apiKey: "sk-ds",
          isDefault: true,
          allowSystemFallback: true,
        },
      ],
      "FREE",
    );
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: TRIAL_KEY },
      remainingBefore: 2,
      remainingAfter: 1,
    });
    chatCompletionMock.mockImplementation(async (cfg: AIClientConfig) => {
      if (cfg.provider === "ANTHROPIC") {
        return completion({ content: "system rescued", provider: "ANTHROPIC", model: "claude-sonnet-4-5-20250929" });
      }
      throw new Error(`${cfg.provider} API error 401: invalid api key`);
    });

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: TENANT,
      govContext: GOV,
    });

    // Chain walked BYOK → trial → system; the trial link did NOT serve the
    // run to completion, so the run-based counter is untouched.
    expect(dialedConfigs().map((c) => c.provider)).toEqual(["DEEPSEEK", "GROQ", "ANTHROPIC"]);
    expect(result.servedBy).toBe("system");
    expect(commitTrialRunMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Circuit breaker integration — pre-flight route-around
// ─────────────────────────────────────────────────────────────────────────

describe("circuit breaker — a tripped head link is routed around before the first dial", () => {
  it("3 prior failures on the default provider send the run straight to the healthy fallback", async () => {
    const { recordProviderFailure } = await import("../../../services/provider-chain");
    seedTenantRows([
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds", isDefault: true },
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-fb", fallbackOrder: 1 },
    ]);
    for (let i = 0; i < 3; i++) recordProviderFailure(TENANT, "DEEPSEEK");
    chatCompletionMock.mockResolvedValue(completion({ content: "healthy link" }));

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: TENANT,
      govContext: GOV,
    });

    // DEEPSEEK was never dialed — the breaker re-routed pre-flight.
    expect(dialedConfigs().map((c) => c.provider)).toEqual(["GROQ"]);
    expect(result.servedBy).toBe("byok-fallback");
    expect(publishRunEventMock).toHaveBeenCalledWith(
      GOV.runId,
      expect.objectContaining({
        type: "PROVIDER_FAILOVER",
        from: "DEEPSEEK",
        to: "GROQ",
        reason: expect.stringContaining("circuit breaker"),
      }),
    );
  });
});
