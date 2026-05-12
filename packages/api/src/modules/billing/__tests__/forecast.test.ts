import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client before importing the module under test.
vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findMany: vi.fn() },
    runStep: { findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}));

import { computeSpendForecast } from "../forecast";
import { prisma } from "../../../lib/db";

const mockedRunFindMany = prisma.run.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedStepFindMany = prisma.runStep.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedTenantFindUnique = prisma.tenant.findUnique as unknown as ReturnType<typeof vi.fn>;

const TENANT = "t-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockedStepFindMany.mockResolvedValue([]);
});

describe("computeSpendForecast", () => {
  it("returns no_budget when monthlyBudgetUsd is null", async () => {
    mockedRunFindMany.mockResolvedValue([]);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: null });

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.budgetUsd).toBeNull();
    expect(forecast.status).toBe("no_budget");
    expect(forecast.currentSpendUsd).toBe(0);
    expect(forecast.projectedMonthEndUsd).toBe(0);
  });

  it("buckets to under_budget when projection ≤ 70% of cap", async () => {
    const today = new Date();
    mockedRunFindMany.mockResolvedValue([
      { costUsd: "10", createdAt: today },
      { costUsd: "5", createdAt: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000) },
    ]);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: "1000" });

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.budgetUsd).toBe(1000);
    expect(forecast.currentSpendUsd).toBeCloseTo(15);
    // Daily avg over 7d window with two days of spend = (10+5)/min(7,daysElapsed+1) → small projection
    expect(forecast.projectedMonthEndUsd).toBeLessThan(700);
    expect(forecast.status).toBe("under_budget");
  });

  it("flips to over_budget when projection exceeds the cap", async () => {
    const now = new Date();
    // 14 days × $100/day = $1,400 spend in window → daily avg $100 → projection ≈ $3000
    const runs = Array.from({ length: 14 }, (_, i) => ({
      costUsd: "100",
      createdAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
    }));
    mockedRunFindMany.mockResolvedValue(runs);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: "200" });

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.status).toBe("over_budget");
    expect(forecast.projectedMonthEndUsd).toBeGreaterThan(200);
  });

  it("produces a 14-day sparkline with the right cardinality", async () => {
    mockedRunFindMany.mockResolvedValue([]);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: null });

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.sparkline).toHaveLength(14);
    expect(forecast.sparkline.every((d) => typeof d.date === "string" && d.costUsd === 0)).toBe(true);
  });

  it("aggregates top 3 cost-driving tools across run_steps", async () => {
    mockedRunFindMany.mockResolvedValue([]);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: null });
    mockedStepFindMany.mockResolvedValue([
      { costUsd: "1.00", toolCalls: [{ toolName: "search" }] },
      { costUsd: "0.50", toolCalls: [{ toolName: "search" }, { toolName: "email" }] },
      { costUsd: "0.20", toolCalls: [{ toolName: "ad_spend" }] },
    ]);

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.topToolsByCost).toHaveLength(3);
    expect(forecast.topToolsByCost[0].toolName).toBe("search");
    expect(forecast.topToolsByCost[0].costUsd).toBeCloseTo(1.25);
    expect(forecast.topToolsByCost[0].callCount).toBe(2);
  });

  it("uses UTC-anchored month bounds", async () => {
    mockedRunFindMany.mockResolvedValue([]);
    mockedTenantFindUnique.mockResolvedValue({ monthlyBudgetUsd: null });

    const forecast = await computeSpendForecast(TENANT);
    expect(forecast.periodStart.getUTCHours()).toBe(0);
    expect(forecast.periodStart.getUTCMinutes()).toBe(0);
    expect(forecast.periodStart.getUTCSeconds()).toBe(0);
    expect(forecast.periodStart.getUTCDate()).toBe(1);
  });
});
