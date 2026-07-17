/**
 * multi-model unit tests (E2/T8 — plan §2.5).
 *
 *   • 3-candidate happy path — parallel allSettled, per-model answers in
 *     configured order, synthesizer (tenant default) consumes them,
 *     STRICT-JSON reply parsed into consensus/disagreements/finalAnswer.
 *   • one candidate fails → dropped (partial result), compare succeeds.
 *   • ALL candidates fail → meaningful error, synthesizer never dialed.
 *   • synthesis JSON parse resilience — fenced/prose-wrapped JSON and
 *     plain-text garbage both survive.
 *   • cost = REAL sum of candidates + synthesizer (rule #8 accounting);
 *     candidate phase reaching maxCostUsd skips the synthesis call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const listLinksMock = vi.hoisted(() => vi.fn());
vi.mock("../provider-chain", () => ({
  listTenantProviderLinks: (...a: unknown[]) => listLinksMock(...a),
}));

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../modules/agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

import { compareAcrossModels, parseSynthesisReply, MAX_CANDIDATES } from "../multi-model";

const TENANT = "tenant-mm";

function link(provider: string, model: string, apiKey = `key-${provider}`) {
  return { provider, source: "byok-fallback" as const, config: { provider, model, apiKey } };
}

interface LoopCall {
  systemPrompt: string;
  userMessage: string;
  toolNames: string[];
  maxTurns?: number;
  maxTokens?: number;
  budgetUsd?: number;
  tenantId?: string;
  aiConfigOverride?: { provider: string; model: string; apiKey: string };
}

function loopResult(overrides: Record<string, unknown> = {}) {
  return {
    finalContent: "answer",
    turns: [],
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.01,
    totalToolCalls: 0,
    ...overrides,
  };
}

const GOOD_SYNTH_JSON = JSON.stringify({
  synthesis: "Models broadly agree.",
  consensus: ["X is true"],
  disagreements: ["[1] disputes the date"],
  finalAnswer: "merged final answer",
});

/** Default dispatch: candidate calls (aiConfigOverride) echo their provider;
 * the synthesizer call (tenantId, no override) returns strict JSON. */
function installDefaultLoopMock(
  candidateCosts: Record<string, number> = {},
  synthCost = 0.04,
): void {
  runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
    if (cfg.aiConfigOverride) {
      const p = cfg.aiConfigOverride.provider;
      return loopResult({
        provider: p,
        model: cfg.aiConfigOverride.model,
        finalContent: `answer-${p}`,
        totalCostUsd: candidateCosts[p] ?? 0.01,
      });
    }
    return loopResult({
      provider: "DEEPSEEK",
      model: "deepseek-chat",
      finalContent: GOOD_SYNTH_JSON,
      totalCostUsd: synthCost,
    });
  });
}

function threeLinks() {
  return [
    link("DEEPSEEK", "deepseek-chat"),
    link("GROQ", "llama-3.3-70b-versatile"),
    link("OPENAI", "gpt-4o"),
  ];
}

const candidateCalls = (): LoopCall[] =>
  runAgentLoopMock.mock.calls.map(([c]) => c as LoopCall).filter((c) => c.aiConfigOverride);
const synthCalls = (): LoopCall[] =>
  runAgentLoopMock.mock.calls.map(([c]) => c as LoopCall).filter((c) => !c.aiConfigOverride);

beforeEach(() => {
  vi.clearAllMocks();
  listLinksMock.mockResolvedValue(threeLinks());
  installDefaultLoopMock();
});

// ─── Happy path ───

describe("compareAcrossModels — 3-candidate happy path", () => {
  it("runs ≤3 candidates in parallel on the tenant's OWN keys and synthesizes with the tenant default", async () => {
    installDefaultLoopMock({ DEEPSEEK: 0.01, GROQ: 0.02, OPENAI: 0.03 });

    const r = await compareAcrossModels(TENANT, "What is the capital of Australia?");

    // Per-model answers in configured order (default row first).
    expect(r.perModel.map((c) => [c.provider, c.answer])).toEqual([
      ["DEEPSEEK", "answer-DEEPSEEK"],
      ["GROQ", "answer-GROQ"],
      ["OPENAI", "answer-OPENAI"],
    ]);
    expect(r.failed).toEqual([]);
    expect(r.perModel[0]!.tokens).toEqual({ input: 100, output: 50 });
    expect(r.perModel[0]!.durationMs).toBeGreaterThanOrEqual(0);

    // Candidate contract: toolless, single turn, forced provider config
    // (T5 aiConfigOverride), per-candidate maxTokens cap.
    const cands = candidateCalls();
    expect(cands).toHaveLength(3);
    for (const c of cands) {
      expect(c.toolNames).toEqual([]);
      expect(c.maxTurns).toBe(1);
      expect(c.maxTokens).toBe(1024);
      // Budget: the whole-compare maxCostUsd ($1.00 default) is split evenly
      // across the 3 candidates so the fan-out can't spend N× the budget
      // (audit finding C-LOGIC-budget). Each candidate gets 1.00/3.
      expect(c.budgetUsd).toBeCloseTo(1.0 / 3, 6);
    }
    expect(cands.map((c) => c.aiConfigOverride!.apiKey)).toEqual([
      "key-DEEPSEEK",
      "key-GROQ",
      "key-OPENAI",
    ]);

    // Synthesizer: tenant-default resolution (tenantId, NO override), sees
    // every candidate answer with its 0-based index.
    const synths = synthCalls();
    expect(synths).toHaveLength(1);
    expect(synths[0]!.tenantId).toBe(TENANT);
    expect(synths[0]!.userMessage).toContain("[0] DEEPSEEK");
    expect(synths[0]!.userMessage).toContain("[2] OPENAI gpt-4o");
    expect(synths[0]!.userMessage).toContain("answer-GROQ");

    // STRICT-JSON distill parsed.
    expect(r.synthesis).toBe("Models broadly agree.");
    expect(r.consensus).toEqual(["X is true"]);
    expect(r.disagreements).toEqual(["[1] disputes the date"]);
    expect(r.finalAnswer).toBe("merged final answer");
    expect(r.synthesisParsed).toBe(true);
    expect(r.synthesizer).toMatchObject({ provider: "DEEPSEEK", costUsd: 0.04 });
    expect(r.budgetExceeded).toBe(false);
  });

  it("clamps candidates to MAX_CANDIDATES(3) — extra configured rows are not dialed", async () => {
    listLinksMock.mockResolvedValue([...threeLinks(), link("MISTRAL", "mistral-large-latest")]);

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(MAX_CANDIDATES).toBe(3);
    expect(r.perModel).toHaveLength(3);
    expect(candidateCalls().map((c) => c.aiConfigOverride!.provider)).toEqual([
      "DEEPSEEK",
      "GROQ",
      "OPENAI",
    ]);
  });

  it("respects opts.maxCandidates below the ceiling", async () => {
    const r = await compareAcrossModels(TENANT, "task under test here", { maxCandidates: 2 });
    expect(r.perModel).toHaveLength(2);
    expect(candidateCalls()).toHaveLength(2);
  });
});

// ─── Partial + total failure ───

describe("compareAcrossModels — candidate failures (allSettled)", () => {
  it("one candidate fails → dropped into `failed`, compare still succeeds on the survivors", async () => {
    installDefaultLoopMock({ DEEPSEEK: 0.01, OPENAI: 0.03 });
    const base = runAgentLoopMock.getMockImplementation()!;
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride?.provider === "GROQ") {
        throw new Error("GROQ API error 401: invalid api key");
      }
      return base(cfg);
    });

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(r.perModel.map((c) => c.provider)).toEqual(["DEEPSEEK", "OPENAI"]);
    expect(r.failed).toEqual([
      {
        provider: "GROQ",
        model: "llama-3.3-70b-versatile",
        error: expect.stringContaining("401"),
      },
    ]);
    // Synthesis ran on the two survivors; cost excludes the failed dial.
    expect(synthCalls()).toHaveLength(1);
    expect(r.totalCostUsd).toBeCloseTo(0.01 + 0.03 + 0.04, 10);
    expect(r.finalAnswer).toBe("merged final answer");
  });

  it("ALL candidates fail → meaningful error naming each provider; synthesizer never dialed", async () => {
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      throw new Error(`${cfg.aiConfigOverride?.provider} API error 401: bad key`);
    });

    await expect(compareAcrossModels(TENANT, "task under test here")).rejects.toThrow(
      /All 3 candidate provider\(s\) failed in multi-model compare: DEEPSEEK\/deepseek-chat/,
    );
    expect(synthCalls()).toHaveLength(0);
  });

  it("tenant with ZERO usable configured providers → meaningful error before any dial", async () => {
    listLinksMock.mockResolvedValue([]);

    await expect(compareAcrossModels(TENANT, "task under test here")).rejects.toThrow(
      /requires at least one configured AI provider/,
    );
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});

// ─── Synthesis parse resilience ───

describe("compareAcrossModels — synthesis JSON parse resilience", () => {
  it("JSON wrapped in prose/code fences still parses (regex block extraction)", async () => {
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride) {
        return loopResult({ provider: cfg.aiConfigOverride.provider, model: cfg.aiConfigOverride.model });
      }
      return loopResult({
        finalContent: "Here is my comparison:\n```json\n" + GOOD_SYNTH_JSON + "\n```",
        totalCostUsd: 0.02,
      });
    });

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(r.synthesisParsed).toBe(true);
    expect(r.finalAnswer).toBe("merged final answer");
    expect(r.consensus).toEqual(["X is true"]);
  });

  it("non-JSON synthesizer reply degrades to raw text — never throws", async () => {
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride) {
        return loopResult({ provider: cfg.aiConfigOverride.provider, model: cfg.aiConfigOverride.model });
      }
      return loopResult({ finalContent: "I think the models mostly agree on 42.", totalCostUsd: 0.02 });
    });

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(r.synthesisParsed).toBe(false);
    expect(r.finalAnswer).toBe("I think the models mostly agree on 42.");
    expect(r.synthesis).toBe("I think the models mostly agree on 42.");
    expect(r.consensus).toEqual([]);
    expect(r.disagreements).toEqual([]);
  });

  it("synthesizer CALL failure degrades to candidates-only result (answers already paid for)", async () => {
    runAgentLoopMock.mockImplementation(async (cfg: LoopCall) => {
      if (cfg.aiConfigOverride) {
        return loopResult({
          provider: cfg.aiConfigOverride.provider,
          model: cfg.aiConfigOverride.model,
          finalContent: `answer-${cfg.aiConfigOverride.provider}`,
          totalCostUsd: 0.01,
        });
      }
      throw new Error("No AI provider configured.");
    });

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(r.perModel).toHaveLength(3);
    expect(r.synthesizer).toBeNull();
    expect(r.synthesizerError).toContain("No AI provider configured");
    expect(r.finalAnswer).toBe("answer-DEEPSEEK"); // first candidate stands in
    expect(r.totalCostUsd).toBeCloseTo(0.03, 10);
  });

  it("parseSynthesisReply: missing finalAnswer falls back to the raw reply", () => {
    const parsed = parseSynthesisReply(JSON.stringify({ synthesis: "s", consensus: [1, "ok"] }));
    expect(parsed.parsed).toBe(true);
    expect(parsed.synthesis).toBe("s");
    expect(parsed.consensus).toEqual(["ok"]); // non-strings filtered
    expect(parsed.finalAnswer).toContain('"synthesis"');
  });
});

// ─── Cost accounting (rule #8) ───

describe("compareAcrossModels — cost = real sum of candidates + synthesizer", () => {
  it("totalCostUsd sums every successful candidate plus the synthesizer", async () => {
    installDefaultLoopMock({ DEEPSEEK: 0.011, GROQ: 0.022, OPENAI: 0.033 }, 0.044);

    const r = await compareAcrossModels(TENANT, "task under test here");

    expect(r.perModel.map((c) => c.costUsd)).toEqual([0.011, 0.022, 0.033]);
    expect(r.synthesizer!.costUsd).toBeCloseTo(0.044, 10);
    expect(r.totalCostUsd).toBeCloseTo(0.011 + 0.022 + 0.033 + 0.044, 10);
  });

  it("candidate phase reaching maxCostUsd SKIPS the synthesis call (budgetExceeded)", async () => {
    installDefaultLoopMock({ DEEPSEEK: 0.03, GROQ: 0.04, OPENAI: 0.05 });

    const r = await compareAcrossModels(TENANT, "task under test here", { maxCostUsd: 0.1 });

    expect(r.budgetExceeded).toBe(true);
    expect(synthCalls()).toHaveLength(0); // never dug deeper
    expect(r.synthesizer).toBeNull();
    expect(r.totalCostUsd).toBeCloseTo(0.12, 10);
    expect(r.finalAnswer).toBe("answer-DEEPSEEK"); // first candidate stands in
  });
});
