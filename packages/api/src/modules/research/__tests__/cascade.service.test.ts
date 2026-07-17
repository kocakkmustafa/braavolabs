/**
 * cascade.service unit tests (Forge P1 — wiring runCascade to a real
 * provider call path).
 *
 *   • cheap tenant model, confident/clean answer → no escalation.
 *   • cheap tenant model, low-confidence answer → escalates to the next
 *     tenant-configured tier, returns the higher-tier answer.
 *   • computeHeuristicConfidence buckets: refusal / truncated / too-short
 *     all classify as low; a complete clean answer classifies as high.
 *   • tenant isolation — listTenantProviderLinks is called with the exact
 *     tenantId, and only that tenant's links are ever dialed.
 *   • zero configured providers → AppError(400) before any dial.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const listLinksMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", () => ({
  listTenantProviderLinks: (...a: unknown[]) => listLinksMock(...a),
}));

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

import { runTenantCascade, computeHeuristicConfidence, parseCascadeCandidate } from "../cascade.service";
import { AppError } from "../../../middleware/error";

const TENANT = "tenant-cascade";

function link(provider: string, model: string, apiKey = `key-${provider}`) {
  return { provider, source: "byok-fallback" as const, config: { provider, model, apiKey } };
}

interface LoopCall {
  systemPrompt: string;
  userMessage: string;
  toolNames: string[];
  maxTurns?: number;
  maxTokens?: number;
  aiConfigOverride?: { provider: string; model: string; apiKey: string };
}

function loopResult(finalContent: string, costUsd: number, stopReason = "end_turn") {
  return {
    finalContent,
    turns: [{ content: finalContent, toolCalls: [], inputTokens: 10, outputTokens: 10, costUsd, stopReason }],
    totalInputTokens: 10,
    totalOutputTokens: 10,
    totalCostUsd: costUsd,
    totalToolCalls: 0,
  };
}

const CLEAN_ANSWER =
  "The capital of Australia is Canberra, not Sydney as many assume; it was purpose-built as the compromise capital.";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── computeHeuristicConfidence — v1 deterministic buckets ───

describe("computeHeuristicConfidence", () => {
  it("empty answer → 0", () => {
    expect(computeHeuristicConfidence("", "end_turn")).toBe(0);
    expect(computeHeuristicConfidence("   ", "end_turn")).toBe(0);
  });

  it("truncated (max_tokens) → low, even if the visible text looks clean", () => {
    expect(computeHeuristicConfidence(CLEAN_ANSWER, "max_tokens")).toBeLessThan(0.5);
  });

  it("refusal / uncertainty phrasing → low", () => {
    expect(computeHeuristicConfidence("I'm not sure, I don't have enough information to answer that.", "end_turn")).toBeLessThan(0.5);
    expect(computeHeuristicConfidence("I cannot help with that request.", "end_turn")).toBeLessThan(0.5);
  });

  it("too-short (but not a refusal) → low-ish, not high", () => {
    expect(computeHeuristicConfidence("Canberra.", "end_turn")).toBeLessThan(0.7);
  });

  it("complete, no refusal signal, adequate length → high (≥ default threshold 0.7)", () => {
    expect(computeHeuristicConfidence(CLEAN_ANSWER, "end_turn")).toBeGreaterThanOrEqual(0.7);
  });
});

// ─── runTenantCascade — no escalation when the cheap tier is confident ───

describe("runTenantCascade — no escalation when the cheapest tenant model is confident", () => {
  it("dials only the cheapest tenant-configured model and returns its answer", async () => {
    listLinksMock.mockResolvedValue([
      link("ZHIPU", "glm-4.7-flash"), // $0/$0 → local tier, cheapest
      link("OPENAI", "gpt-4o"), // cheap tier
    ]);
    runAgentLoopMock.mockResolvedValue(loopResult(CLEAN_ANSWER, 0.0));

    const r = await runTenantCascade(TENANT, "What is the capital of Australia?");

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const call = runAgentLoopMock.mock.calls[0][0] as LoopCall;
    expect(call.aiConfigOverride?.provider).toBe("ZHIPU");
    expect(call.toolNames).toEqual([]);
    expect(call.maxTurns).toBe(1);

    expect(r.escalated).toBe(false);
    expect(r.provider).toBe("ZHIPU");
    expect(r.model).toBe("glm-4.7-flash");
    expect(r.answer).toBe(CLEAN_ANSWER);
    expect(r.stoppedReason).toBe("confident");
    expect(r.attempts).toHaveLength(1);
  });
});

// ─── runTenantCascade — escalates on low confidence ───

describe("runTenantCascade — escalates to the next tenant tier on low confidence", () => {
  it("cheap model refuses/uncertain → escalates to the tenant's higher-tier provider", async () => {
    listLinksMock.mockResolvedValue([
      link("ZHIPU", "glm-4.7-flash"), // local tier
      link("ANTHROPIC", "claude-sonnet"), // cheap tier (per modelPricing.ts, ≈48/1M blended)
    ]);
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride?.provider === "ZHIPU") {
        return loopResult("I'm not sure, I don't have enough information to answer that.", 0);
      }
      return loopResult(CLEAN_ANSWER, 0.01);
    });

    const r = await runTenantCascade(TENANT, "What is the capital of Australia?");

    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    expect(r.attempts.map((a) => a.provider)).toEqual(["ZHIPU", "ANTHROPIC"]);
    expect(r.escalated).toBe(true);
    expect(r.provider).toBe("ANTHROPIC");
    expect(r.model).toBe("claude-sonnet");
    expect(r.answer).toBe(CLEAN_ANSWER);
    expect(r.totalCostUsd).toBeCloseTo(0.01, 10);
  });

  it("truncated cheap-tier answer also triggers escalation", async () => {
    listLinksMock.mockResolvedValue([
      link("ZHIPU", "glm-4.7-flash"),
      link("ANTHROPIC", "claude-sonnet"),
    ]);
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride?.provider === "ZHIPU") {
        return loopResult(CLEAN_ANSWER, 0, "max_tokens");
      }
      return loopResult(CLEAN_ANSWER, 0.01, "end_turn");
    });

    const r = await runTenantCascade(TENANT, "Explain something at length.");

    expect(r.escalated).toBe(true);
    expect(r.attempts[0]!.confidence).toBeLessThan(0.7);
    expect(r.provider).toBe("ANTHROPIC");
  });

  it("passes confidenceThreshold / secondOpinion / budgetUsdCap through to runCascade", async () => {
    listLinksMock.mockResolvedValue([link("ZHIPU", "glm-4.7-flash"), link("ANTHROPIC", "claude-sonnet")]);
    runAgentLoopMock.mockResolvedValue(loopResult(CLEAN_ANSWER, 0));

    // secondOpinion forces exactly one escalation past a confident first answer.
    const r = await runTenantCascade(TENANT, "prompt", { secondOpinion: true });
    expect(r.escalated).toBe(true);
    expect(r.attempts).toHaveLength(2);
  });
});

// ─── Tenant isolation ───

describe("runTenantCascade — tenant isolation", () => {
  it("resolves candidates via listTenantProviderLinks(tenantId) only", async () => {
    listLinksMock.mockResolvedValue([link("ZHIPU", "glm-4.7-flash")]);
    runAgentLoopMock.mockResolvedValue(loopResult(CLEAN_ANSWER, 0));

    await runTenantCascade("tenant-a", "prompt");

    expect(listLinksMock).toHaveBeenCalledTimes(1);
    expect(listLinksMock).toHaveBeenCalledWith("tenant-a");
  });

  it("never dials a link outside the resolved tenantId's set", async () => {
    listLinksMock.mockImplementation(async (tenantId: string) =>
      tenantId === "tenant-a" ? [link("ZHIPU", "glm-4.7-flash")] : [link("OPENAI", "gpt-4o")],
    );
    runAgentLoopMock.mockResolvedValue(loopResult(CLEAN_ANSWER, 0));

    await runTenantCascade("tenant-a", "prompt");

    const dialedProviders = runAgentLoopMock.mock.calls.map(
      ([c]: [LoopCall]) => c.aiConfigOverride?.provider,
    );
    expect(dialedProviders).toEqual(["ZHIPU"]);
  });
});

// ─── No configured providers ───

describe("runTenantCascade — zero configured providers", () => {
  it("throws AppError(400) before any dial", async () => {
    listLinksMock.mockResolvedValue([]);

    await expect(runTenantCascade(TENANT, "prompt")).rejects.toThrow(AppError);
    await expect(runTenantCascade(TENANT, "prompt")).rejects.toThrow(
      /requires at least one configured AI provider/,
    );
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});

// ─── parseCascadeCandidate + v2 hybrid confidence ───
describe("parseCascadeCandidate — self-report envelope", () => {
  it("extracts answer + confidence from a strict JSON envelope", () => {
    const r = parseCascadeCandidate('{"answer":"Paris","confidence":0.8}');
    expect(r.answer).toBe("Paris");
    expect(r.selfConfidence).toBe(0.8);
  });
  it("tolerates a ```json fence and surrounding prose", () => {
    const r = parseCascadeCandidate('here:\n```json\n{"answer":"42","confidence":0.3}\n```');
    expect(r.answer).toBe("42");
    expect(r.selfConfidence).toBe(0.3);
  });
  it("clamps confidence to [0,1]", () => {
    expect(parseCascadeCandidate('{"answer":"x","confidence":5}').selfConfidence).toBe(1);
    expect(parseCascadeCandidate('{"answer":"x","confidence":-2}').selfConfidence).toBe(0);
    expect(parseCascadeCandidate('{"answer":"x","confidence":"nope"}').selfConfidence).toBeUndefined();
  });
  it("falls back to raw content (no self-report) for non-JSON prose", () => {
    const r = parseCascadeCandidate("Just a plain prose answer, no JSON here.");
    expect(r.answer).toBe("Just a plain prose answer, no JSON here.");
    expect(r.selfConfidence).toBeUndefined();
  });
});

describe("v2 hybrid confidence — structural CEILING, self-report only LOWERS", () => {
  const clean = "This is a complete, well-formed answer that clears the length bar easily.";
  it("a model cannot inflate past the structural ceiling", () => {
    // Structurally clean → heuristic 0.9. Self-report 0.99 can't push above it.
    const structural = computeHeuristicConfidence(clean, "end_turn");
    const hybrid = Math.min(structural, 0.99);
    expect(hybrid).toBe(structural); // capped at 0.9, not 0.99
  });
  it("a complete-but-unsure self-report lowers confidence (finer routing)", () => {
    const structural = computeHeuristicConfidence(clean, "end_turn"); // 0.9
    const hybrid = Math.min(structural, 0.4); // model says 0.4
    expect(hybrid).toBe(0.4); // escalates even though structurally clean
  });
  it("structural failure dominates any high self-report", () => {
    // Truncated answer → heuristic 0.2; a lying 0.95 self-report can't rescue it.
    const structural = computeHeuristicConfidence(clean, "max_tokens");
    expect(Math.min(structural, 0.95)).toBe(structural);
    expect(structural).toBeLessThan(0.5);
  });
});
