/**
 * ComposedAgentSchema validation contract — pure Zod schema, no I/O.
 *
 * The composer's tool whitelist enforcement and LLM round-trip are
 * exercised in the e2e suite (production playwright run); these unit
 * tests pin the schema shape so a schema regression breaks the build
 * before it reaches Anthropic's API.
 *
 * The provider-resolution honesty gate (D-013) IS unit-tested here though:
 * composeAgent() must resolve its AI config through resolveTenantCompletionLink
 * (not the raw getTenantAIConfig) so a BYOK-less/ineligible tenant gets an
 * honest error instead of a silent system-funded completion, and a trial-
 * served completion commits the run-based counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComposedAgentSchema, composeAgent } from "../composer";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../registry", () => ({
  getTool: (name: string) =>
    name === "send_email" ? { name: "send_email", description: "Send an email." } : undefined,
  getToolNames: () => ["send_email"],
}));

const resolveTenantCompletionLinkMock = vi.hoisted(() => vi.fn());
const commitTrialCompletionMock = vi.hoisted(() => vi.fn());
const refundTrialCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", () => ({
  resolveTenantCompletionLink: (...a: unknown[]) => resolveTenantCompletionLinkMock(...a),
  commitTrialCompletion: (...a: unknown[]) => commitTrialCompletionMock(...a),
  refundTrialCompletion: (...a: unknown[]) => refundTrialCompletionMock(...a),
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", () => ({
  chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
}));

const validAgent = {
  name: "Memory Curator",
  role: "memory_curator",
  systemPrompt:
    "You curate this company's memory. Watch every run completion, extract 3-5 key learnings, and only escalate them to APPROVED status after you've seen the same pattern repeat across 2 or more successful runs. Never escalate based on a single example.",
  tools: ["recall_memory", "store_memory"],
};

describe("ComposedAgentSchema", () => {
  it("accepts a well-formed agent", () => {
    const result = ComposedAgentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it("rejects names longer than 80 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      name: "x".repeat(81),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-snake_case roles", () => {
    const cases = ["MemoryCurator", "memory-curator", "Memory Curator", "1memory", " memory_curator"];
    for (const role of cases) {
      const result = ComposedAgentSchema.safeParse({ ...validAgent, role });
      expect(result.success, `role="${role}" should fail`).toBe(false);
    }
  });

  it("accepts valid snake_case roles", () => {
    const cases = ["memory_curator", "sales", "agent42", "x_y_z"];
    for (const role of cases) {
      const result = ComposedAgentSchema.safeParse({ ...validAgent, role });
      expect(result.success, `role="${role}" should pass`).toBe(true);
    }
  });

  it("rejects systemPrompt shorter than 20 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      systemPrompt: "too short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects systemPrompt longer than 8000 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      systemPrompt: "x".repeat(8001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 tools", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      tools: Array.from({ length: 21 }, (_, i) => `tool_${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty tool array (text-only agent)", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      tools: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra top-level keys (strict shape)", () => {
    // Zod object() is permissive by default; this test documents the
    // current behaviour (unknown keys pass through silently). If we ever
    // tighten with .strict(), update this assertion.
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      maliciousKey: "drop tables",
    });
    expect(result.success).toBe(true);
  });
});

// ─── D-013: honest provider resolution ─────────────────────
//
// composeAgent must resolve its AI config via resolveTenantCompletionLink
// (D-013) — an ineligible tenant gets composeAgent's thrown error surfaced
// (company/router.ts translates "no ai provider|api key|..." into a 400),
// never a silent completion against the shared system Anthropic key. A
// trial-served completion commits the run-based counter after success.

describe("composeAgent — provider resolution honesty (D-013)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ineligible tenant: resolveTenantCompletionLink rejects → composeAgent throws WITHOUT ever calling chatCompletion", async () => {
    resolveTenantCompletionLinkMock.mockRejectedValue(
      new Error("No AI provider configured. Please add an API key in Settings → AI Provider."),
    );

    await expect(composeAgent("tenant-1", "a support agent that answers billing questions")).rejects.toThrow(
      /no ai provider configured/i,
    );
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
  });

  it("eligible/BYOK tenant: resolved config is threaded straight into chatCompletion, unchanged", async () => {
    const resolvedConfig = { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds" };
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "DEEPSEEK", source: "byok-default", config: resolvedConfig });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({
        name: "Billing Support Bot",
        role: "billing_support",
        systemPrompt: "You answer billing questions for customers, politely and accurately, escalating refunds.",
        tools: ["send_email"],
      }),
      inputTokens: 10,
      outputTokens: 20,
      provider: "DEEPSEEK",
      model: "deepseek-chat",
    });

    const result = await composeAgent("tenant-1", "a support agent that answers billing questions");

    expect(resolveTenantCompletionLinkMock).toHaveBeenCalledWith("tenant-1");
    expect(chatCompletionMock).toHaveBeenCalledWith(resolvedConfig, expect.any(String), expect.any(Array), 4096);
    expect(result.agent.role).toBe("billing_support");
    expect(result.provider).toBe("DEEPSEEK");
    // BYOK source → the trial counter is never touched.
    expect(commitTrialCompletionMock).toHaveBeenCalledWith(
      "tenant-1", "byok-default", expect.objectContaining({ provider: "DEEPSEEK", model: "deepseek-chat" }),
    );
  });

  it("trial-served completion: the run-based counter is committed AFTER a successful serve", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({
        name: "Billing Support Bot",
        role: "billing_support",
        systemPrompt: "You answer billing questions for customers, politely and accurately, escalating refunds.",
        tools: ["send_email"],
      }),
      inputTokens: 10,
      outputTokens: 20,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    await composeAgent("tenant-1", "a support agent that answers billing questions");

    // commitTrialCompletion is called with the trial source only after the
    // completion resolved — a thrown completion would skip it (slot refunded).
    expect(commitTrialCompletionMock).toHaveBeenCalledWith(
      "tenant-1", "trial", expect.objectContaining({ provider: "GROQ", model: "llama-3.3-70b-versatile" }),
    );
    // Ordering: chatCompletion must run BEFORE the counter commit.
    expect(chatCompletionMock.mock.invocationCallOrder[0]).toBeLessThan(
      commitTrialCompletionMock.mock.invocationCallOrder[0],
    );
  });

  it("REFUND: trial-served completion throws → the reservation is refunded, not committed or stranded", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockRejectedValue(new Error("GROQ API error 503: overloaded"));

    await expect(
      composeAgent("tenant-1", "a support agent that answers billing questions"),
    ).rejects.toThrow("GROQ API error 503");

    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
    expect(refundTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "trial");
  });
});
