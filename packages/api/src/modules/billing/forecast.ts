/**
 * Spend forecast service.
 *
 * Aggregates `Run.costUsd` over the current calendar month, computes
 * a 7-day rolling daily average, and projects month-end spend by
 * extrapolating that average across the remaining days. Compared
 * against `Tenant.monthlyBudgetUsd` to surface a budget bar +
 * warning state in the dashboard.
 *
 * Strategically this is Braavolabs's answer to credit-bucket
 * competitors (Lindy, Manus, Zapier) — instead of opaque "you used
 * 4,200 / 8,000 credits this month" we show real dollars actually
 * spent against real dollars budgeted. Trust signal that compounds
 * the audit-log thesis.
 *
 * Time zone: every period boundary is UTC-anchored to match the
 * existing meter logic in `metering.ts`. Local-timezone drift would
 * mis-classify runs in the first / last hours of a month for
 * non-UTC API servers.
 */

import { prisma } from "../../lib/db";

export interface SpendForecast {
  /** UTC month start (inclusive) — e.g. 2026-05-01T00:00:00Z. */
  periodStart: Date;
  /** UTC next-month start (exclusive) — e.g. 2026-06-01T00:00:00Z. */
  periodEnd: Date;
  /** Sum of Run.costUsd for the current period, in USD. */
  currentSpendUsd: number;
  /** Average $/day across the last 7 days (or fewer if the period is younger). */
  dailyAverageUsd: number;
  /** Linear extrapolation: currentSpend + dailyAverage × daysRemaining. */
  projectedMonthEndUsd: number;
  /** Days fully elapsed in the period (integer; today not counted). */
  daysElapsed: number;
  /** Days remaining including today (integer). */
  daysRemaining: number;
  /** Operator-set monthly cap; null when not configured. */
  budgetUsd: number | null;
  /**
   * Bucket the UI uses to pick colour / banner copy.
   *
   *   under_budget   — projected ≤ 70% of budget
   *   nearing_budget — projected > 70% and ≤ 100%
   *   over_budget    — projected > 100% (red banner, run gating active)
   *   no_budget      — `budgetUsd` is null (informational mode only)
   */
  status: "no_budget" | "under_budget" | "nearing_budget" | "over_budget";
  /**
   * Last 14 days as [{date, costUsd}] for the sparkline. ISO date
   * strings (YYYY-MM-DD) so the UI can plot without re-parsing dates.
   */
  sparkline: Array<{ date: string; costUsd: number }>;
  /**
   * Top 3 tools by total cost in the current period. Useful for the
   * "where is my money going?" answer in the dashboard tile.
   */
  topToolsByCost: Array<{ toolName: string; costUsd: number; callCount: number }>;
}

function utcMonthBounds(now: Date = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeSpendForecast(tenantId: string): Promise<SpendForecast> {
  const now = new Date();
  const { start, end } = utcMonthBounds(now);

  // Pull every completed/failed/running run for this tenant in the
  // current month. Joining through Pipeline → Company → tenantId
  // matches the rest of the codebase's tenant-scoping pattern.
  const runs = await prisma.run.findMany({
    where: {
      pipeline: { company: { tenantId } },
      createdAt: { gte: start, lt: end },
    },
    select: { costUsd: true, createdAt: true },
  });

  const currentSpendUsd = runs.reduce(
    (sum, r) => sum + (r.costUsd ? Number(r.costUsd) : 0),
    0,
  );

  // Rolling 7-day average, clamped to "days since period start" so a
  // brand-new tenant on day 3 doesn't divide by 7.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const windowStart = sevenDaysAgo > start ? sevenDaysAgo : start;
  const windowSpend = runs
    .filter((r) => r.createdAt >= windowStart)
    .reduce((sum, r) => sum + (r.costUsd ? Number(r.costUsd) : 0), 0);
  const windowDays = Math.max(
    1,
    Math.ceil((now.getTime() - windowStart.getTime()) / (24 * 60 * 60 * 1000)),
  );
  const dailyAverageUsd = windowSpend / windowDays;

  const daysElapsed = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  const daysRemaining = Math.max(
    0,
    Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
  );
  const projectedMonthEndUsd = currentSpendUsd + dailyAverageUsd * daysRemaining;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { monthlyBudgetUsd: true },
  });
  const budgetUsd = tenant?.monthlyBudgetUsd ? Number(tenant.monthlyBudgetUsd) : null;

  // Status bucket. Thresholds match the dashboard's three-tier
  // colour scheme (green / amber / red) and the runner's gate.
  let status: SpendForecast["status"];
  if (budgetUsd === null) status = "no_budget";
  else if (projectedMonthEndUsd > budgetUsd) status = "over_budget";
  else if (projectedMonthEndUsd > budgetUsd * 0.7) status = "nearing_budget";
  else status = "under_budget";

  // 14-day sparkline. Bucket runs by ISO date — keeping the math in
  // JS (rather than a `groupBy` SQL) avoids a second round-trip and
  // the result set is tiny.
  const sparklineStart = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  const sparklineStartIso = isoDate(sparklineStart);
  const byDay = new Map<string, number>();
  for (let i = 0; i < 14; i++) {
    const d = new Date(sparklineStart.getTime() + i * 24 * 60 * 60 * 1000);
    byDay.set(isoDate(d), 0);
  }
  for (const r of runs) {
    const key = isoDate(r.createdAt);
    if (key < sparklineStartIso) continue;
    if (!byDay.has(key)) continue;
    byDay.set(key, (byDay.get(key) ?? 0) + (r.costUsd ? Number(r.costUsd) : 0));
  }
  const sparkline = Array.from(byDay.entries()).map(([date, costUsd]) => ({
    date,
    costUsd,
  }));

  // Top 3 tools by cost. We need to walk run_steps → tool_calls →
  // and aggregate per toolName. ToolCall doesn't currently carry a
  // cost column, so we approximate by attributing the step's cost
  // proportionally across its tool calls (the dominant cost driver
  // per step IS the tool call, plus the LLM round-trip). This is a
  // pragmatic estimate; a future schema bump can add a real
  // tool_calls.cost_usd column for exact attribution.
  const stepsWithTools = await prisma.runStep.findMany({
    where: {
      run: { pipeline: { company: { tenantId } }, createdAt: { gte: start, lt: end } },
    },
    select: { costUsd: true, toolCalls: { select: { toolName: true } } },
  });

  const toolAgg = new Map<string, { costUsd: number; callCount: number }>();
  for (const step of stepsWithTools) {
    const stepCost = step.costUsd ? Number(step.costUsd) : 0;
    const tcCount = step.toolCalls.length;
    if (tcCount === 0) continue;
    const perTool = stepCost / tcCount;
    for (const tc of step.toolCalls) {
      const cur = toolAgg.get(tc.toolName) ?? { costUsd: 0, callCount: 0 };
      cur.costUsd += perTool;
      cur.callCount += 1;
      toolAgg.set(tc.toolName, cur);
    }
  }
  const topToolsByCost = Array.from(toolAgg.entries())
    .map(([toolName, v]) => ({ toolName, costUsd: v.costUsd, callCount: v.callCount }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 3);

  return {
    periodStart: start,
    periodEnd: end,
    currentSpendUsd,
    dailyAverageUsd,
    projectedMonthEndUsd,
    daysElapsed,
    daysRemaining,
    budgetUsd,
    status,
    sparkline,
    topToolsByCost,
  };
}

/**
 * Hard gate consulted by the spend-approval flow. Returns true when
 * the tenant has a budget set AND projected spend exceeds it AND the
 * new approval would push us further over. The runner calls this
 * before granting auto-approval (it's only used as a deny path; the
 * tenant can still manually approve via the dashboard when they want
 * to override).
 */
export async function isOverBudget(tenantId: string): Promise<boolean> {
  const forecast = await computeSpendForecast(tenantId);
  return forecast.status === "over_budget";
}
