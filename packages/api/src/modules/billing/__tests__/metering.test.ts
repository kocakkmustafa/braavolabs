/**
 * Usage metering — claimQuota / releaseQuota / checkQuota / incrementMeter.
 *
 * claimQuota is the TOCTOU-safe atomic gate used at POST /pipelines/:id/run
 * and the webhook fan-out (ISS-010); releaseQuota is its FINDINGS M3
 * refund path when a claimed run then fails to enqueue. Neither had a test
 * file before this suite — the webhook router tests mock both wholesale,
 * so the actual quota arithmetic (limit resolution per plan, the atomic
 * upsert's WHERE-clause failure path, the fail-open error handling) was
 * never exercised directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const usageMeterUpsert = vi.hoisted(() => vi.fn());
const usageMeterFindUnique = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const queryRawMock = vi.hoisted(() => vi.fn());
const executeRawMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    usageMeter: {
      upsert: (...a: unknown[]) => usageMeterUpsert(...a),
      findUnique: (...a: unknown[]) => usageMeterFindUnique(...a),
    },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    $executeRaw: (...a: unknown[]) => executeRawMock(...a),
  },
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envMock = vi.hoisted(() => ({ BYPASS_BILLING: false }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { claimQuota, releaseQuota, checkQuota, incrementMeter } from "../metering";
import { logger } from "../../../lib/logger";

const TENANT = "tenant-1";

beforeEach(() => {
  vi.clearAllMocks();
  envMock.BYPASS_BILLING = false;
});

describe("claimQuota", () => {
  it("BYPASS_BILLING short-circuits before any prisma call", async () => {
    envMock.BYPASS_BILLING = true;
    const result = await claimQuota(TENANT, "runs");
    expect(result).toEqual({ claimed: true, value: -1, limit: -1 });
    expect(tenantFindUnique).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("a metric other than 'runs' has no plan limit — bumps the meter but never gates", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    usageMeterUpsert.mockResolvedValue({ value: 5 });

    const result = await claimQuota(TENANT, "storage");

    expect(result).toEqual({ claimed: true, value: -1, limit: -1 });
    expect(usageMeterUpsert).toHaveBeenCalledTimes(1);
    // The gated atomic-upsert SQL path is never touched for unlimited metrics.
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("ENTERPRISE plan (maxRunsPerMonth = -1) treats 'runs' as unlimited too", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "ENTERPRISE" });
    usageMeterUpsert.mockResolvedValue({ value: 42 });

    const result = await claimQuota(TENANT, "runs");

    expect(result).toEqual({ claimed: true, value: -1, limit: -1 });
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("within limit — the atomic upsert's conditional WHERE succeeds, returns the claimed value", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" }); // maxRunsPerMonth = 10
    queryRawMock.mockResolvedValue([{ value: 4 }]);

    const result = await claimQuota(TENANT, "runs");

    expect(result).toEqual({ claimed: true, value: 4, limit: 10 });
    // Scoped to the right tenant/metric — tagged-template call receives
    // (stringsArray, tenantId, metric, 1, periodStart, periodEnd).
    expect(queryRawMock.mock.calls[0]![1]).toBe(TENANT);
    expect(queryRawMock.mock.calls[0]![2]).toBe("runs");
  });

  it("over limit — WHERE clause on the UPDATE fails (empty rows), falls back to reading the current value", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    queryRawMock.mockResolvedValue([]);
    usageMeterFindUnique.mockResolvedValue({ value: 10 });

    const result = await claimQuota(TENANT, "runs");

    expect(result).toEqual({ claimed: false, value: 10, limit: 10 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, metric: "runs", value: 10, limit: 10 }),
      expect.stringMatching(/over limit/i),
    );
  });

  it("over limit with no existing meter row at all — reports `limit` as the value rather than throwing", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    queryRawMock.mockResolvedValue([]);
    usageMeterFindUnique.mockResolvedValue(null);

    const result = await claimQuota(TENANT, "runs");

    expect(result).toEqual({ claimed: false, value: 10, limit: 10 });
  });

  it("a missing tenant row is fail-closed to the FREE plan's limit, not unlimited", async () => {
    tenantFindUnique.mockResolvedValue(null);
    queryRawMock.mockResolvedValue([{ value: 1 }]);

    const result = await claimQuota("ghost-tenant", "runs");

    expect(result.limit).toBe(10); // FREE plan's maxRunsPerMonth, never -1
  });
});

describe("releaseQuota", () => {
  it("BYPASS_BILLING short-circuits without touching prisma", async () => {
    envMock.BYPASS_BILLING = true;
    await releaseQuota(TENANT, "runs");
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("issues a GREATEST(0, value - amount) clamped decrement scoped to tenant/metric/period", async () => {
    executeRawMock.mockResolvedValue(1);

    await releaseQuota(TENANT, "runs");

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    // Tagged-template call receives (stringsArray, amount, tenantId, metric, periodStart)
    // in the order they're interpolated into the SQL above.
    const args = executeRawMock.mock.calls[0]!;
    expect(args[2]).toBe(TENANT);
    expect(args[3]).toBe("runs");
  });

  it("a DB failure is swallowed (non-fatal) — the caller (webhook fan-out) must never see this throw", async () => {
    executeRawMock.mockRejectedValue(new Error("connection reset"));

    await expect(releaseQuota(TENANT, "runs")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, metric: "runs" }),
      expect.stringMatching(/releaseQuota failed/i),
    );
  });
});

describe("checkQuota — read-only badge/summary check (not the TOCTOU-safe gate)", () => {
  it("BYPASS_BILLING short-circuits to unlimited without a DB read", async () => {
    envMock.BYPASS_BILLING = true;
    const result = await checkQuota(TENANT, "runs");
    expect(result).toEqual({ allowed: true, remaining: -1, limit: -1 });
    expect(usageMeterFindUnique).not.toHaveBeenCalled();
  });

  it("unlimited plan (ENTERPRISE) → allowed with no remaining cap", async () => {
    usageMeterFindUnique.mockResolvedValue({ value: 999 });
    tenantFindUnique.mockResolvedValue({ plan: "ENTERPRISE" });

    const result = await checkQuota(TENANT, "runs");

    expect(result).toEqual({ allowed: true, remaining: -1, limit: -1 });
  });

  it("under limit → allowed true, remaining is the real headroom", async () => {
    usageMeterFindUnique.mockResolvedValue({ value: 3 });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" }); // limit 10

    const result = await checkQuota(TENANT, "runs");

    expect(result).toEqual({ allowed: true, remaining: 7, limit: 10 });
  });

  it("at/over limit → allowed false, remaining clamped at 0 (never negative)", async () => {
    usageMeterFindUnique.mockResolvedValue({ value: 15 });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });

    const result = await checkQuota(TENANT, "runs");

    expect(result).toEqual({ allowed: false, remaining: 0, limit: 10 });
  });

  it("no meter row yet this period → treated as 0 usage, not an error", async () => {
    usageMeterFindUnique.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });

    const result = await checkQuota(TENANT, "runs");

    expect(result).toEqual({ allowed: true, remaining: 10, limit: 10 });
  });
});

describe("incrementMeter", () => {
  it("flags exceeded once the new value crosses the plan's limit", async () => {
    usageMeterUpsert.mockResolvedValue({ value: 11 });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" }); // limit 10

    const result = await incrementMeter(TENANT, "runs");

    expect(result).toEqual({ value: 11, limit: 10, exceeded: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, metric: "runs", value: 11, limit: 10 }),
      expect.stringMatching(/usage limit exceeded/i),
    );
  });

  it("does not flag exceeded while strictly within the limit", async () => {
    usageMeterUpsert.mockResolvedValue({ value: 5 });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });

    const result = await incrementMeter(TENANT, "runs");

    expect(result).toEqual({ value: 5, limit: 10, exceeded: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
