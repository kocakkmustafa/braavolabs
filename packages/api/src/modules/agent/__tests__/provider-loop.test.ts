/**
 * Unified provider agent loop (E2/T4) — mocked chatCompletion, zero network.
 *
 * Covers the plan's required paths:
 *   • 2-turn native tool-use loop on a non-Anthropic provider (governed
 *     executeTool + canonical transcript round-trip),
 *   • steering drain → injection + STEERING_APPLIED event (now on every
 *     provider path, not just Anthropic),
 *   • budget-stop with REAL modelPricing costs (flat $2/$8 estimate gone),
 *   • fail-expensive pricing for unknown non-Anthropic models (§2.6),
 *   • $0 pricing for local providers,
 *   • ToolsUnsupportedError → prompt-embedded single-shot fallback,
 *   • maxTokens threading (hardcoded 4096 removed — A8),
 *   • model hierarchy resolveModelForProvider (§2.4 / F-020),
 *   • trial path routed through the unified loop with the maxTurns clamp.
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

const steeringFindMany = vi.hoisted(() => vi.fn());
const steeringUpdateMany = vi.hoisted(() => vi.fn());
const aiConfigFindMany = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    steeringMessage: {
      findMany: (...a: unknown[]) => steeringFindMany(...a),
      updateMany: (...a: unknown[]) => steeringUpdateMany(...a),
    },
    userAIConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      // The T7 chain builder resolves tenant rows via findMany.
      findMany: (...a: unknown[]) => aiConfigFindMany(...a),
    },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
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

// Registry — one known test tool; everything else unregistered.
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

// ai-client — ONLY chatCompletion mocked; everything else
// (ToolsUnsupportedError, resolveModelForProvider, catalogues) REAL.
const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
  };
});

import { runAgentLoop, runProviderAgentLoop, type AgentGovContext } from "../claude";
import {
  ToolsUnsupportedError,
  resolveModelForProvider,
  type ChatCompletionResult,
  type AIClientConfig,
} from "../../../services/ai-client";
import { resetProviderCircuits } from "../../../services/provider-chain";

const GROQ_CONFIG: AIClientConfig = {
  provider: "GROQ",
  model: "llama-3.3-70b-versatile",
  apiKey: "gsk-test",
};

const GOV: AgentGovContext = {
  tenantId: "tenant-1",
  companyId: "co-1",
  runId: "run-1",
  runStepId: "rs-1",
};

function completion(partial: Partial<ChatCompletionResult>): ChatCompletionResult {
  return {
    content: "",
    inputTokens: 10,
    outputTokens: 5,
    model: "llama-3.3-70b-versatile",
    provider: "GROQ",
    stopReason: "stop",
    ...partial,
  };
}

/** Seed tenant-1 with a single default BYOK row matching `cfg` — the T7
 * chain builder (real code) resolves it to the chain head, which is what
 * the pre-T7 getTenantAIConfig mock used to hand the loop directly. */
function seedTenantProvider(cfg: AIClientConfig): void {
  aiConfigFindMany.mockResolvedValue([
    {
      id: "cfg-1",
      tenantId: "tenant-1",
      provider: cfg.provider,
      model: cfg.model,
      encryptedApiKey: cfg.apiKey ? `enc:${cfg.apiKey}` : null,
      baseUrl: cfg.baseUrl ?? null,
      isDefault: true,
      fallbackOrder: null,
      allowSystemFallback: false,
      createdAt: new Date(2026, 0, 1),
    },
  ]);
  decryptMock.mockImplementation((blob: string) => {
    if (blob === `enc:${cfg.apiKey}`) return cfg.apiKey;
    throw new Error("decrypt failed");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderCircuits();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
  seedTenantProvider({ ...GROQ_CONFIG });
  tenantFindUnique.mockResolvedValue({ plan: "PRO" });
  activityLogCreate.mockResolvedValue({});
  steeringFindMany.mockResolvedValue([]);
  steeringUpdateMany.mockResolvedValue({ count: 0 });
  executeToolMock.mockResolvedValue({ status: "SUCCESS", output: { ok: true }, durationMs: 3 });
  tryConsumeTrialRunMock.mockResolvedValue(null);
});

// ── 2-turn native tool loop on a non-Anthropic provider ──

describe("unified loop — native tool-use on non-Anthropic provider", () => {
  it("runs a real multi-turn loop: executes tools via governed executeTool and feeds results back", async () => {
    executeToolMock.mockResolvedValue({
      status: "SUCCESS",
      output: { time: "14:00" },
      durationMs: 7,
    });
    chatCompletionMock
      .mockResolvedValueOnce(
        completion({
          content: "Checking the clock.",
          toolCalls: [{ id: "c1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' }],
          stopReason: "tool_calls",
          inputTokens: 100,
          outputTokens: 50,
          toolUseMode: "native",
        }),
      )
      .mockResolvedValueOnce(
        completion({ content: "It is 14:00 UTC.", inputTokens: 120, outputTokens: 30 }),
      );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "what time is it?",
      toolNames: ["get_time"],
      model: "claude-sonnet-4-20250514", // composer default — incompatible with GROQ
      tenantId: "tenant-1",
      govContext: GOV,
    });

    // Loop shape
    expect(result.turns).toHaveLength(2);
    expect(result.finalContent).toBe("It is 14:00 UTC.");
    expect(result.totalToolCalls).toBe(1);
    expect(result.toolUseMode).toBe("native");
    expect(result.turns[0].stopReason).toBe("tool_use");
    expect(result.turns[0].toolCalls[0]).toMatchObject({
      id: "c1",
      name: "get_time",
      input: { timezone: "UTC" },
      output: { time: "14:00" },
    });

    // Governed execution with parsed args + gov context
    expect(executeToolMock).toHaveBeenCalledExactlyOnceWith("get_time", { timezone: "UTC" }, GOV);

    // Model hierarchy (§2.4): incompatible Agent.model skipped → tenant model
    const firstCallConfig = chatCompletionMock.mock.calls[0][0] as AIClientConfig;
    expect(firstCallConfig.model).toBe("llama-3.3-70b-versatile");

    // Native tools travel on the wire
    expect((chatCompletionMock.mock.calls[0][4] as { tools?: unknown[] }).tools).toHaveLength(1);

    // Canonical transcript round-trip: assistant toolCalls + role:"tool" result
    const secondMessages = chatCompletionMock.mock.calls[1][2] as Array<Record<string, unknown>>;
    expect(secondMessages).toEqual([
      { role: "user", content: "what time is it?" },
      {
        role: "assistant",
        content: "Checking the clock.",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' }],
      },
      { role: "tool", toolCallId: "c1", content: JSON.stringify({ time: "14:00" }) },
    ]);

    // Real modelPricing cost (llama-3.3-70b @ $0.59/$0.79 per M) — not $2/$8
    const expected = (220 / 1_000_000) * 0.59 + (80 / 1_000_000) * 0.79;
    expect(result.totalCostUsd).toBeCloseTo(expected, 9);
  });
});

// ── Steering drain ──

describe("unified loop — steering drain (v2 moat, every provider)", () => {
  it("injects pending STEER messages into the transcript and publishes STEERING_APPLIED", async () => {
    steeringFindMany
      .mockResolvedValueOnce([
        {
          id: "s1",
          kind: "STEER",
          content: "focus on the EU market",
          targetAgentId: null,
        },
      ])
      .mockResolvedValue([]);
    chatCompletionMock.mockResolvedValue(completion({ content: "ok" }));

    await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "do the task",
      toolNames: [],
      tenantId: "tenant-1",
      govContext: GOV,
    });

    const messages = chatCompletionMock.mock.calls[0][2] as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1].content).toContain(
      "[Operator steering]: focus on the EU market",
    );
    expect(steeringUpdateMany).toHaveBeenCalledOnce();
    expect(publishRunEventMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ type: "STEERING_APPLIED" }),
    );
  });
});

// ── Budget stop with real pricing ──

describe("unified loop — budget stop (real modelPricing, §2.6)", () => {
  it("stops after the turn that exceeds budgetUsd even when the model wants more tools", async () => {
    // gpt-4-turbo @ $10/$30 per M: 100k in + 50k out = $2.50 > $1 budget
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "spendy",
        model: "gpt-4-turbo",
        provider: "OPENAI",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
        inputTokens: 100_000,
        outputTokens: 50_000,
      }),
    );
    seedTenantProvider({
      provider: "OPENAI",
      model: "gpt-4-turbo",
      apiKey: "sk-oai",
    });

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: ["get_time"],
      budgetUsd: 1.0,
      tenantId: "tenant-1",
      govContext: GOV,
    });

    expect(result.turns).toHaveLength(1);
    expect(result.totalCostUsd).toBeCloseTo(2.5, 6);
    // The overspending turn's tools still executed (legacy ordering kept)
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("prices unknown non-Anthropic models fail-expensive (gpt-4-turbo class $10/$30)", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({ content: "?", model: "mystery-model-9", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: "tenant-1",
    });

    expect(result.totalCostUsd).toBeCloseTo(40, 6);
  });

  it("prices local providers at $0 (own hardware)", async () => {
    seedTenantProvider({
      provider: "OLLAMA",
      model: "qwen2.5:7b",
      apiKey: "",
    });
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "local",
        model: "qwen2.5:7b",
        provider: "OLLAMA",
        inputTokens: 500_000,
        outputTokens: 500_000,
      }),
    );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: "tenant-1",
    });

    expect(result.totalCostUsd).toBe(0);
  });
});

// ── Prompt fallback ──

describe("unified loop — ToolsUnsupportedError → prompt-embedded fallback", () => {
  it("downgrades to a single prompt-embedded shot and marks toolUseMode", async () => {
    chatCompletionMock
      .mockRejectedValueOnce(
        new ToolsUnsupportedError("OLLAMA", "gemma3:4b", "does not support tools"),
      )
      .mockResolvedValueOnce(completion({ content: "best-effort answer", model: "gemma3:4b", provider: "OLLAMA" }));
    seedTenantProvider({
      provider: "OLLAMA",
      model: "gemma3:4b",
      apiKey: "",
    });

    const result = await runAgentLoop({
      systemPrompt: "base prompt",
      userMessage: "go",
      toolNames: ["get_time"],
      tenantId: "tenant-1",
    });

    expect(result.toolUseMode).toBe("prompt-fallback");
    expect(result.turns).toHaveLength(1);
    expect(result.finalContent).toBe("best-effort answer");

    // Second call: tools embedded in the system prompt, none on the wire
    const retrySystem = chatCompletionMock.mock.calls[1][1] as string;
    expect(retrySystem).toContain("Available tools:");
    expect(retrySystem).toContain("- get_time: Return the current time for a timezone");
    const retryOptions = chatCompletionMock.mock.calls[1][4] as { tools?: unknown[] };
    expect(retryOptions.tools).toBeUndefined();
  });

  it("rethrows non-capability errors instead of downgrading", async () => {
    chatCompletionMock.mockRejectedValue(new Error("GROQ API error 401: invalid key"));

    await expect(
      runProviderAgentLoop(
        { systemPrompt: "sys", userMessage: "go", toolNames: ["get_time"] },
        { ...GROQ_CONFIG },
      ),
    ).rejects.toThrow(/401/);
  });
});

// ── maxTokens threading (A8) ──

describe("unified loop — maxTokens travels to the wire", () => {
  it("passes config.maxTokens through (hardcoded 4096 removed)", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "ok" }));

    await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      maxTokens: 512,
      tenantId: "tenant-1",
    });

    expect(chatCompletionMock.mock.calls[0][3]).toBe(512);
  });

  it("defaults to 4096 when unset", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "ok" }));

    await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      tenantId: "tenant-1",
    });

    expect(chatCompletionMock.mock.calls[0][3]).toBe(4096);
  });
});

// ── Trial path compatibility (behavioural order unchanged — D-009 is T7's) ──

describe("unified loop — trial Groq path", () => {
  it("routes trial runs through the unified loop with the maxTurns clamp and commits after success", async () => {
    // BYOK-less FREE tenant — the T7 chain enters through the counted trial.
    aiConfigFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    tryConsumeTrialRunMock.mockResolvedValue({
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
      remainingBefore: 3,
      remainingAfter: 2,
    });
    // Model keeps asking for tools — an unclamped loop would run 10 turns
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "again",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      }),
    );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: ["get_time"],
      maxTurns: 10,
      tenantId: "tenant-1",
      govContext: GOV,
    });

    expect(result.turns).toHaveLength(4); // TRIAL_MAX_TURNS clamp (plan T4/A8)
    expect(commitTrialRunMock).toHaveBeenCalledExactlyOnceWith("tenant-1");
  });
});

// ── aiConfigOverride (E2/T5 — D-010 bench provider forcing) ──

describe("runAgentLoop — aiConfigOverride skips tenant resolution", () => {
  it("forces the exact provider config through to chatCompletion's provider switch", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({ content: "forced", provider: "DEEPSEEK", model: "deepseek-chat" }),
    );

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      // tenantId present on purpose — the override must still win and the
      // tenant/trial resolution paths must never be consulted.
      tenantId: "tenant-1",
      model: "deepseek-chat",
      aiConfigOverride: { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "bench-env-key" },
    });

    // Tenant resolution never consulted: no row lookup, no trial check.
    expect(aiConfigFindMany).not.toHaveBeenCalled();
    expect(tryConsumeTrialRunMock).not.toHaveBeenCalled();
    // The override config is what reaches the chatCompletion provider switch.
    const cfg = chatCompletionMock.mock.calls[0][0] as AIClientConfig;
    expect(cfg).toMatchObject({
      provider: "DEEPSEEK",
      model: "deepseek-chat",
      apiKey: "bench-env-key",
    });
    // The loop reports the actually-used provider/model back (bench
    // persists these on the BenchRun row).
    expect(result.provider).toBe("DEEPSEEK");
    expect(result.model).toBe("deepseek-chat");
  });

  it("resolves the model hierarchy against the OVERRIDE provider (incompatible agent model falls to the override model)", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "ok", provider: "GROQ" }));

    const result = await runAgentLoop({
      systemPrompt: "sys",
      userMessage: "go",
      toolNames: [],
      model: "claude-sonnet-4-20250514", // incompatible with GROQ → skipped
      aiConfigOverride: { provider: "GROQ", model: "llama-3.1-8b-instant", apiKey: "gsk-bench" },
    });

    const cfg = chatCompletionMock.mock.calls[0][0] as AIClientConfig;
    expect(cfg.model).toBe("llama-3.1-8b-instant");
    expect(result.model).toBe("llama-3.1-8b-instant");
  });
});

// ── System-path guard parity ──

describe("unified loop — system Anthropic fallback guard", () => {
  it("throws the historical 'not initialized' error when no system key exists", async () => {
    envMock.ANTHROPIC_API_KEY = "";

    await expect(
      runAgentLoop({ systemPrompt: "sys", userMessage: "go", toolNames: [] }),
    ).rejects.toThrow(/Anthropic API client not initialized/);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });
});

// ── Model hierarchy (§2.4 / F-020) ──

describe("resolveModelForProvider — Agent.model > tenant model > provider default", () => {
  it("uses a catalogue-compatible agent model", () => {
    expect(
      resolveModelForProvider("GROQ", "llama-3.1-8b-instant", "llama-3.3-70b-versatile"),
    ).toBe("llama-3.1-8b-instant");
  });

  it("skips an incompatible agent model (composer default claude-* on GROQ)", () => {
    expect(
      resolveModelForProvider("GROQ", "claude-sonnet-4-20250514", "llama-3.3-70b-versatile"),
    ).toBe("llama-3.3-70b-versatile");
  });

  it("falls to the provider default when neither agent nor tenant model applies", () => {
    expect(resolveModelForProvider("DEEPSEEK", "claude-sonnet-4-20250514", undefined)).toBe(
      "deepseek-chat",
    );
    expect(resolveModelForProvider("GROQ", undefined, null)).toBe("llama-3.3-70b-versatile");
  });

  it("accepts legacy claude ids on ANTHROPIC and honours the tenant model otherwise", () => {
    expect(
      resolveModelForProvider("ANTHROPIC", "claude-3-5-sonnet-20241022", "claude-haiku-4-5-20251001"),
    ).toBe("claude-3-5-sonnet-20241022");
    expect(resolveModelForProvider("ANTHROPIC", "gpt-4o", "claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("local providers are open-ended EXCEPT for cloud-catalogue ids (§2.4 guard)", () => {
    // user-pulled tag passes freely
    expect(resolveModelForProvider("OLLAMA", "my-finetune:7b", "gemma3:4b")).toBe("my-finetune:7b");
    // composer default claude-* must NOT be sent to Ollama
    expect(resolveModelForProvider("OLLAMA", "claude-sonnet-4-20250514", "gemma3:4b")).toBe(
      "gemma3:4b",
    );
    expect(resolveModelForProvider("LMSTUDIO", "gpt-4o", undefined)).toBe("google/gemma-3-4b-it");
  });
});
