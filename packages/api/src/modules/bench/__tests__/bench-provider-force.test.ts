/**
 * Bench provider forcing (E2/T5 — D-010) — mocked runAgentLoop, zero network.
 *
 * Before this fix `runBenchSuite` called the tenant-less runAgentLoop,
 * which ALWAYS landed on system Anthropic while the BenchRun row claimed
 * `opts.provider`. Covered here:
 *   • candidate + judge calls carry aiConfigOverride (provider really forced),
 *   • env key resolution order: BENCH_<PROVIDER>_KEY > system key,
 *   • cloud combination without any key → SKIP + report (no error, no
 *     phantom BenchRun row, zero tokens spent),
 *   • missing judge (ANTHROPIC) key → SKIP before burning candidate tokens,
 *   • local providers run keyless (never key-skipped),
 *   • BenchRun row records the ACTUALLY-used model + per-task toolUseMode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  GROQ_API_KEY: undefined as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-5-20250929",
  OFFLINE_MODE: false,
  NATIVE_TOOLUSE_PROVIDERS: undefined as string | undefined,
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const benchSuiteFindUnique = vi.hoisted(() => vi.fn());
const benchRunCreate = vi.hoisted(() => vi.fn());
const benchRunFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    benchSuite: {
      findUnique: (...a: unknown[]) => benchSuiteFindUnique(...a),
      upsert: vi.fn(),
    },
    benchRun: {
      create: (...a: unknown[]) => benchRunCreate(...a),
      findFirst: (...a: unknown[]) => benchRunFindFirst(...a),
    },
  },
}));

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

import { runBenchSuite, resolveBenchProviderConfig, BENCH_NONCOMPLETED_DEDUP_WINDOW_MS } from "../bench.service";

// Env hygiene: every BENCH_* var this file touches is snapshotted and restored.
const TOUCHED_ENV = [
  "BENCH_GROQ_KEY",
  "BENCH_ANTHROPIC_KEY",
  "BENCH_DEEPSEEK_KEY",
  "BENCH_OLLAMA_BASE_URL",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

const SUITE = {
  id: "suite-1",
  slug: "agent-reasoning",
  maxScorePerTask: 10,
  tasks: [
    { id: "t1", prompt: "What is 2+2?", rubric: "Says 4." },
    { id: "t2", prompt: "Capital of France?", rubric: "Says Paris." },
  ],
};

function loopResult(partial: Record<string, unknown> = {}) {
  return {
    finalContent: "answer",
    turns: [],
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCostUsd: 0.01,
    totalToolCalls: 0,
    toolUseMode: "native",
    provider: "GROQ",
    model: "llama-3.3-70b-versatile",
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of TOUCHED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
  envMock.GROQ_API_KEY = undefined;
  benchSuiteFindUnique.mockResolvedValue(SUITE);
  benchRunCreate.mockResolvedValue({ id: "run-1" });
  benchRunFindFirst.mockResolvedValue(null);
  // Default: candidate answer, then judge verdict — alternating per task.
  runAgentLoopMock.mockImplementation(async (cfg: { aiConfigOverride?: { provider: string } }) =>
    cfg.aiConfigOverride?.provider === "ANTHROPIC"
      ? loopResult({
          finalContent: '{"score": 8, "notes": "solid"}',
          totalCostUsd: 0.002,
          provider: "ANTHROPIC",
          model: "claude-sonnet-4-5-20250929",
        })
      : loopResult(),
  );
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── Key resolution (env-based — bench is tenant-less, plan §2.5/A3) ──

describe("resolveBenchProviderConfig — env key resolution", () => {
  it("prefers BENCH_<PROVIDER>_KEY over the system key", () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    envMock.GROQ_API_KEY = "gsk-system";
    expect(resolveBenchProviderConfig("GROQ", "llama-3.3-70b-versatile")).toMatchObject({
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      apiKey: "gsk-bench",
    });
  });

  it("falls back to the system key (GROQ_API_KEY / ANTHROPIC_API_KEY / generic <PROVIDER>_API_KEY)", () => {
    envMock.GROQ_API_KEY = "gsk-system";
    expect(resolveBenchProviderConfig("GROQ", "m")?.apiKey).toBe("gsk-system");
    expect(resolveBenchProviderConfig("ANTHROPIC", "m")?.apiKey).toBe("sk-ant-system-key");
    process.env.DEEPSEEK_API_KEY = "ds-system";
    expect(resolveBenchProviderConfig("DEEPSEEK", "m")?.apiKey).toBe("ds-system");
  });

  it("returns null for a cloud provider without any key", () => {
    expect(resolveBenchProviderConfig("GROQ", "m")).toBeNull();
    expect(resolveBenchProviderConfig("DEEPSEEK", "m")).toBeNull();
  });

  it("local providers run keyless and honour BENCH_<PROVIDER>_BASE_URL", () => {
    expect(resolveBenchProviderConfig("OLLAMA", "qwen2.5:7b")).toMatchObject({
      provider: "OLLAMA",
      apiKey: "",
    });
    process.env.BENCH_OLLAMA_BASE_URL = "http://10.0.0.5:11434/v1";
    expect(resolveBenchProviderConfig("OLLAMA", "qwen2.5:7b")?.baseUrl).toBe(
      "http://10.0.0.5:11434/v1",
    );
  });
});

// ── Skip path: no key → report, no error, no phantom row ──

describe("runBenchSuite — skip without keys", () => {
  it("skips a cloud combination with no key: reports, spends nothing, writes only a SKIPPED audit row", async () => {
    const result = await runBenchSuite({
      suiteSlug: "agent-reasoning",
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    expect(result).toEqual({
      skipped: true,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      reason: expect.stringContaining("BENCH_GROQ_KEY"),
    });
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(benchRunCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        suiteId: "suite-1", provider: "GROQ", scoresByTask: [], scoreNormalised: 0,
        costUsd: 0, status: "SKIPPED", errorCode: "NO_CANDIDATE_KEY",
        durationMs: expect.any(Number),
      }),
    });
  });

  it("skips when the judge (ANTHROPIC) key is missing — BEFORE burning candidate tokens", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    envMock.ANTHROPIC_API_KEY = undefined;

    const result = await runBenchSuite({
      suiteSlug: "agent-reasoning",
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: expect.stringContaining("judge"),
    });
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(benchRunCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ status: "SKIPPED", errorCode: "NO_JUDGE_KEY", scoreNormalised: 0 }),
    });
  });
});

// ── Forced provider: aiConfigOverride really reaches the loop ──

describe("runBenchSuite — provider×model genuinely forced (D-010)", () => {
  it("passes aiConfigOverride to candidate calls and pins the judge to Anthropic", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";

    const result = await runBenchSuite({
      suiteSlug: "agent-reasoning",
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    // 2 tasks × (candidate + judge) = 4 loop calls
    expect(runAgentLoopMock).toHaveBeenCalledTimes(4);

    const candidateCall = runAgentLoopMock.mock.calls[0][0];
    expect(candidateCall.aiConfigOverride).toEqual({
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      apiKey: "gsk-bench",
    });
    expect(candidateCall.model).toBe("llama-3.3-70b-versatile");

    const judgeCall = runAgentLoopMock.mock.calls[1][0];
    expect(judgeCall.aiConfigOverride).toEqual({
      provider: "ANTHROPIC",
      model: "claude-sonnet-5-5",
      apiKey: "sk-ant-system-key",
    });

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.runId).toBe("run-1");
      expect(result.score).toBeCloseTo(8 / 10, 9);
      expect(result.cost).toBeCloseTo(2 * (0.01 + 0.002), 9);
    }
  });

  it("persists the ACTUALLY-used provider/model and per-task toolUseMode on the BenchRun row", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    // Loop reports a different actually-used model + a prompt-fallback task.
    runAgentLoopMock.mockImplementation(async (cfg: { aiConfigOverride?: { provider: string } }) =>
      cfg.aiConfigOverride?.provider === "ANTHROPIC"
        ? loopResult({ finalContent: '{"score": 6, "notes": "ok"}', totalCostUsd: 0.002 })
        : loopResult({ model: "llama-3.3-70b-versatile-actual", toolUseMode: "prompt-fallback" }),
    );

    await runBenchSuite({
      suiteSlug: "agent-reasoning",
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    expect(benchRunCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        provider: "GROQ",
        model: "llama-3.3-70b-versatile-actual",
        scoresByTask: [
          expect.objectContaining({ taskId: "t1", score: 6, toolUseMode: "prompt-fallback" }),
          expect.objectContaining({ taskId: "t2", score: 6, toolUseMode: "prompt-fallback" }),
        ],
      }),
    });
  });
});

// ── BRA-P1-05-N2: failure audit row ──

describe("runBenchSuite — FAILED audit row", () => {
  it("writes a FAILED row (constant code, no raw error) and rethrows the original error", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    runAgentLoopMock.mockRejectedValue(new Error("boom sk-secret-123 stack"));

    await expect(
      runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m", notes: "n" }),
    ).rejects.toThrow("boom");

    expect(benchRunCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        suiteId: "suite-1", provider: "GROQ", model: "m", scoresByTask: [], scoreNormalised: 0,
        costUsd: 0, status: "FAILED", errorCode: "RUN_ERROR", notes: "n",
        durationMs: expect.any(Number),
      }),
    });
    expect(JSON.stringify(benchRunCreate.mock.calls[0][0])).not.toContain("sk-secret");
  });

  it("FAILED row carries the cost spent before the failure", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    let n = 0;
    runAgentLoopMock.mockImplementation(async (cfg: { aiConfigOverride?: { provider: string } }) => {
      if (++n > 2) throw new Error("boom");
      return cfg.aiConfigOverride?.provider === "ANTHROPIC"
        ? loopResult({ finalContent: '{"score": 6, "notes": "ok"}', totalCostUsd: 0.002 })
        : loopResult();
    });
    await expect(
      runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" }),
    ).rejects.toThrow("boom");
    const row = benchRunCreate.mock.calls[0][0].data;
    expect(row.status).toBe("FAILED");
    expect(row.costUsd).toBeCloseTo(0.012, 9);
  });

  it("a failing audit-row write never masks the original error", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    runAgentLoopMock.mockRejectedValue(new Error("boom"));
    benchRunCreate.mockRejectedValue(new Error("db down"));
    await expect(
      runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" }),
    ).rejects.toThrow("boom");
  });

  it("writes no row when the suite is unknown", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    benchSuiteFindUnique.mockResolvedValue(null);
    await expect(
      runBenchSuite({ suiteSlug: "nope", provider: "GROQ", model: "m" }),
    ).rejects.toThrow("not found");
    expect(benchRunCreate).not.toHaveBeenCalled();
  });
});

// ── BRA-ADAY-3: repeated identical non-completed outcome is audited once ──

const NOW = Date.parse("2026-11-18T12:00:00Z");
describe("runBenchSuite — non-completed dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write a second SKIPPED row when the same outcome exists within the window", async () => {
    benchRunFindFirst.mockResolvedValue({ id: "existing" });
    const result = await runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" });
    expect(result).toMatchObject({ skipped: true });
    expect(benchRunFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        suiteId: "suite-1", provider: "GROQ", model: "m", status: "SKIPPED",
        errorCode: "NO_CANDIDATE_KEY",
        ranAt: { gte: new Date(NOW - BENCH_NONCOMPLETED_DEDUP_WINDOW_MS) },
      },
      select: { id: true },
    });
    expect(benchRunCreate).not.toHaveBeenCalled();
  });

  it("does not write a second costless FAILED row but still rethrows the original error", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    runAgentLoopMock.mockRejectedValue(new Error("boom"));
    benchRunFindFirst.mockResolvedValue({ id: "existing" });
    await expect(
      runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" }),
    ).rejects.toThrow("boom");
    expect(benchRunFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        suiteId: "suite-1", provider: "GROQ", model: "m", status: "FAILED",
        errorCode: "RUN_ERROR",
        ranAt: { gte: new Date(NOW - BENCH_NONCOMPLETED_DEDUP_WINDOW_MS) },
      },
      select: { id: true },
    });
    expect(benchRunCreate).not.toHaveBeenCalled();
  });

  it("a FAILED run that spent money is never deduplicated", async () => {
    process.env.BENCH_GROQ_KEY = "gsk-bench";
    let n = 0;
    runAgentLoopMock.mockImplementation(async (cfg: { aiConfigOverride?: { provider: string } }) => {
      if (++n > 2) throw new Error("boom");
      return cfg.aiConfigOverride?.provider === "ANTHROPIC"
        ? loopResult({ finalContent: '{"score": 6, "notes": "ok"}', totalCostUsd: 0.002 })
        : loopResult();
    });
    benchRunFindFirst.mockResolvedValue({ id: "existing" });
    await expect(
      runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" }),
    ).rejects.toThrow("boom");
    expect(benchRunFindFirst).not.toHaveBeenCalled();
    expect(benchRunCreate).toHaveBeenCalledTimes(1);
    expect(benchRunCreate.mock.calls[0][0].data.costUsd).toBeGreaterThan(0);
  });

  it("window is one hour", () => {
    expect(BENCH_NONCOMPLETED_DEDUP_WINDOW_MS).toBe(3_600_000);
  });

  it("fails open: a dedup lookup error still writes the row", async () => {
    benchRunFindFirst.mockRejectedValue(new Error("db down"));
    await runBenchSuite({ suiteSlug: "agent-reasoning", provider: "GROQ", model: "m" });
    expect(benchRunCreate).toHaveBeenCalledTimes(1);
  });
});
