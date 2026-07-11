import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client before importing the module under test — same
// convention as forecast.test.ts.
vi.mock("../../../lib/db", () => ({
  prisma: {
    runStep: { findMany: vi.fn() },
  },
}));

import { computeTenantSavings } from "../savings.service";
import { prisma } from "../../../lib/db";

const mockedFindMany = prisma.runStep.findMany as unknown as ReturnType<typeof vi.fn>;

const TENANT = "tenant-A";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeTenantSavings", () => {
  it("reconstructs a SavingsReport whose actual spend matches the real cost_usd sum", async () => {
    mockedFindMany.mockResolvedValue([
      { costUsd: "0.01", agent: { model: "claude-haiku" } },
      { costUsd: "0", agent: { model: "glm-4.7-flash" } }, // free/local-tier model
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.sampleSize).toBe(2);
    // Real dollars actually billed (0.01 + 0) must survive the token-split
    // reconstruction essentially exactly — this is the core correctness
    // property of buildRunEvent's cost-preserving split.
    expect(result.report.actualUsd).toBeCloseTo(0.01, 4);
    // Both events costed against the frontier baseline (claude-opus) show
    // real, positive savings — cheap-tier routing + a free/local model.
    expect(result.report.savedUsd).toBeGreaterThan(0);
    expect(result.report.savedPct).toBeGreaterThan(50);
    // No cache/retrieval data is ever logged anywhere in the schema today —
    // the report must not claim savings it can't back up.
    expect(result.report.breakdown.cacheUsd).toBe(0);
    expect(result.report.breakdown.retrievalUsd).toBe(0);
  });

  it("scopes every query to the tenant via the run -> pipeline -> company hop (tenant isolation)", async () => {
    mockedFindMany.mockResolvedValue([]);

    await computeTenantSavings(TENANT, 7);

    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    const whereArg = mockedFindMany.mock.calls[0]![0].where;
    expect(whereArg.run).toEqual({ pipeline: { company: { tenantId: TENANT } } });
  });

  it("skips run_steps with no agent/model association instead of guessing", async () => {
    mockedFindMany.mockResolvedValue([
      { costUsd: "0.05", agent: { model: "claude-sonnet-4-20250514" } },
      { costUsd: "0.02", agent: null },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.sampleSize).toBe(1);
  });

  it("returns a zero report for an empty period without dividing by zero", async () => {
    mockedFindMany.mockResolvedValue([]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.sampleSize).toBe(0);
    expect(result.report.actualUsd).toBe(0);
    expect(result.report.savedUsd).toBe(0);
    expect(result.report.savedPct).toBe(0);
  });

  it("clamps the days window to [1, 90] and defaults to 7", async () => {
    mockedFindMany.mockResolvedValue([]);

    const tooMany = await computeTenantSavings(TENANT, 500);
    expect(tooMany.period.days).toBe(90);

    const zeroOrLess = await computeTenantSavings(TENANT, 0);
    expect(zeroOrLess.period.days).toBe(1);

    const defaulted = await computeTenantSavings(TENANT);
    expect(defaulted.period.days).toBe(7);
  });

  it("flags model ids absent from the pricing table instead of silently mispricing them", async () => {
    mockedFindMany.mockResolvedValue([
      { costUsd: "1.23", agent: { model: "some-custom-finetune-v9" } },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.unknownModelIds).toContain("some-custom-finetune-v9");
  });

  it("uses REAL logged prompt_tokens/completion_tokens directly — no reconstruction — when both are present", async () => {
    // claude-sonnet: $3/$15 per 1M. 2000 in + 500 out -> exact real cost.
    const realCostUsd = (2000 / 1_000_000) * 3 + (500 / 1_000_000) * 15;
    mockedFindMany.mockResolvedValue([
      {
        costUsd: String(realCostUsd),
        promptTokens: 2000,
        completionTokens: 500,
        cachedInputTokens: null,
        agent: { model: "claude-sonnet-4-20250514" },
      },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.sampleSize).toBe(1);
    expect(result.realTokenSampleSize).toBe(1);
    expect(result.reconstructedSampleSize).toBe(0);
    // Real tokens x real per-model pricing reproduce the real cost_usd
    // exactly (no reconstruction/rounding involved).
    expect(result.report.actualUsd).toBeCloseTo(realCostUsd, 6);
    expect(result.note).toContain("1/1 run_steps used REAL logged");
    expect(result.note).toContain("0/1");
  });

  it("feeds real cached_input_tokens into a non-zero breakdown.cacheUsd (only possible with logged data)", async () => {
    mockedFindMany.mockResolvedValue([
      {
        costUsd: "0.02",
        promptTokens: 2000,
        completionTokens: 500,
        cachedInputTokens: 1000,
        agent: { model: "claude-sonnet-4-20250514" },
      },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.realTokenSampleSize).toBe(1);
    // Cache savings can only ever be non-zero for a real-token row — a
    // reconstructed row never invents cachedInputTokens.
    expect(result.report.breakdown.cacheUsd).toBeGreaterThan(0);
  });

  it("handles a mixed batch — real-token rows use logged data, legacy (NULL) rows fall back to reconstruction", async () => {
    mockedFindMany.mockResolvedValue([
      {
        costUsd: "0.03",
        promptTokens: 2000,
        completionTokens: 500,
        cachedInputTokens: null,
        agent: { model: "claude-sonnet-4-20250514" },
      },
      // Legacy row — predates the migration, no token columns.
      { costUsd: "0.01", agent: { model: "claude-haiku" } },
      // Legacy row with an explicit NULL (same as undefined — still falls back).
      {
        costUsd: "0.005",
        promptTokens: null,
        completionTokens: null,
        cachedInputTokens: null,
        agent: { model: "claude-haiku" },
      },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.sampleSize).toBe(3);
    expect(result.realTokenSampleSize).toBe(1);
    expect(result.reconstructedSampleSize).toBe(2);
    expect(result.note).toContain("1/3 run_steps used REAL logged");
    expect(result.note).toContain("2/3");
    // Every real dollar (real cost_usd for legacy rows + real-tokens-priced
    // cost for the logged row) still lands in actualUsd — nothing is dropped.
    expect(result.report.actualUsd).toBeGreaterThan(0);
  });

  it("falls back to reconstruction when only one of promptTokens/completionTokens is logged (malformed row)", async () => {
    mockedFindMany.mockResolvedValue([
      {
        costUsd: "0.01",
        promptTokens: 2000,
        completionTokens: null,
        cachedInputTokens: null,
        agent: { model: "claude-haiku" },
      },
    ]);

    const result = await computeTenantSavings(TENANT, 7);

    expect(result.realTokenSampleSize).toBe(0);
    expect(result.reconstructedSampleSize).toBe(1);
  });
});
