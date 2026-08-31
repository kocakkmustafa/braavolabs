import { beforeEach, describe, expect, it, vi } from "vitest";

const usageMeterUpsert = vi.hoisted(() => vi.fn());
const usageMeterFindUnique = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const queryRawMock = vi.hoisted(() => vi.fn());
const executeRawMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    usageMeter: {
      upsert: (...args: unknown[]) => usageMeterUpsert(...args),
      findUnique: (...args: unknown[]) => usageMeterFindUnique(...args),
    },
    tenant: { findUnique: (...args: unknown[]) => tenantFindUnique(...args) },
  },
  tenantTx: (fn: (tx: unknown) => unknown) => fn({
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
  }),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envMock = vi.hoisted(() => ({ BYPASS_BILLING: false }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { checkQuota, claimQuota, incrementMeter, releaseQuota } from "../metering";
import { logger } from "../../../lib/logger";

const TENANT = "tenant-1";

beforeEach(() => {
  vi.clearAllMocks();
  envMock.BYPASS_BILLING = false;
  usageMeterUpsert.mockResolvedValue({ value: 1 });
  usageMeterFindUnique.mockResolvedValue(null);
});

describe("subscription-only metering", () => {
  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])(
    "%s has no plan-funded run quota; usage is telemetry only",
    async (plan) => {
      tenantFindUnique.mockResolvedValue({ plan });
      const result = await claimQuota(TENANT, "runs");
      expect(result).toEqual({ claimed: true, value: -1, limit: -1 });
      expect(usageMeterUpsert).toHaveBeenCalledTimes(1);
      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it.each(["model_tokens", "inference_cost_usd", "provider_calls"])(
    "%s can be counted but never becomes a bundled entitlement",
    async (metric) => {
      tenantFindUnique.mockResolvedValue({ plan: "TEAM" });
      const result = await claimQuota(TENANT, metric);
      expect(result).toEqual({ claimed: true, value: -1, limit: -1 });
      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, { plan: "FREE" }, { plan: "BUSINESS" }, { plan: "UNKNOWN" }])(
    "missing or ambiguous plan %# fails closed before a run is claimed",
    async (tenant) => {
      tenantFindUnique.mockResolvedValue(tenant);
      const result = await claimQuota(TENANT, "runs");
      expect(result).toEqual({ claimed: false, value: 0, limit: 0 });
      expect(queryRawMock).not.toHaveBeenCalled();
      expect(usageMeterUpsert).not.toHaveBeenCalled();
    },
  );

  it("read-only quota state is unlimited for canonical plans and closed for manual review", async () => {
    tenantFindUnique.mockResolvedValueOnce({ plan: "INDIVIDUAL" });
    await expect(checkQuota(TENANT, "runs")).resolves.toEqual({ allowed: true, remaining: -1, limit: -1 });

    tenantFindUnique.mockResolvedValueOnce({ plan: "MANUAL_REVIEW" });
    await expect(checkQuota(TENANT, "runs")).resolves.toEqual({ allowed: false, remaining: 0, limit: 0 });
  });

  it("incrementMeter marks a manual-review run as exceeded instead of treating zero as unlimited", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "MANUAL_REVIEW" });
    usageMeterUpsert.mockResolvedValue({ value: 1 });
    await expect(incrementMeter(TENANT, "runs")).resolves.toEqual({ value: 1, limit: 0, exceeded: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, value: 1, limit: 0 }),
      expect.stringMatching(/exceeded/i),
    );
  });
});

describe("quota bookkeeping safety", () => {
  it("billing bypass remains an explicit development-only short circuit", async () => {
    envMock.BYPASS_BILLING = true;
    await expect(claimQuota(TENANT, "runs")).resolves.toEqual({ claimed: true, value: -1, limit: -1 });
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it("release is clamped and scoped; a DB error remains non-fatal", async () => {
    executeRawMock.mockResolvedValueOnce(1);
    await releaseQuota(TENANT, "runs");
    expect(executeRawMock).toHaveBeenCalledTimes(1);

    executeRawMock.mockRejectedValueOnce(new Error("connection reset"));
    await expect(releaseQuota(TENANT, "runs")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, metric: "runs" }),
      expect.stringMatching(/releaseQuota failed/i),
    );
  });
});
