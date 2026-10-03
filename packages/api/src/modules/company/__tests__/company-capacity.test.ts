import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
vi.mock("../../../lib/db", () => ({ prisma: {}, tenantTx: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
import { assertCompanyCapacity } from "../company-capacity";

function transaction(plan: string | null, count: number) {
  const query = vi.fn().mockResolvedValue(plan === null ? [] : [{ plan }]);
  const companyCount = vi.fn().mockResolvedValue(count);
  const entitlementFindMany = vi.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: query,
    company: { count: companyCount },
    entitlementEvent: { findMany: entitlementFindMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, query, companyCount, entitlementFindMany };
}

describe("assertCompanyCapacity", () => {
  it("reads expired ledger authority on the same locked transaction instead of granting stale Individual", async () => {
    const { tx, query, entitlementFindMany } = transaction("INDIVIDUAL", 0);
    entitlementFindMany.mockResolvedValue([{
      id: "local-expired-grant", source: "google", streamId: "local-google-stream",
      sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL",
      expiresAt: new Date(Date.now() - 1_000), autoRenew: true,
    }]);
    await expect(assertCompanyCapacity(tx, "tenant-1")).rejects.toMatchObject({ statusCode: 402 });
    expect(entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(entitlementFindMany.mock.invocationCallOrder[0]);
  });

  it.each([
    ["MANUAL_REVIEW", 0, 402],
    ["FREE", 0, 402],
    ["BUSINESS", 0, 402],
    ["INDIVIDUAL", 4, 0],
    ["CREATOR", 5, 402],
    ["TEAM", 19, 0],
    ["PRO", 20, 402],
    ["UNKNOWN_TIER", 0, 402],
  ])("checks %s with %i existing companies", async (plan, count, expectedStatus) => {
    const { tx, query, companyCount } = transaction(plan, count);
    const result = assertCompanyCapacity(tx, "tenant-1");
    if (expectedStatus) {
      await expect(result).rejects.toMatchObject({ statusCode: expectedStatus });
    } else {
      await expect(result).resolves.toBeUndefined();
    }
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0].join("?")).toMatch(/FOR UPDATE/);
    expect(query.mock.calls[0][1]).toBe("tenant-1");
    expect(companyCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
  });

  it("counts every company, including ARCHIVED, by omitting a status filter", async () => {
    const { tx, companyCount } = transaction("INDIVIDUAL", 5);
    await expect(assertCompanyCapacity(tx, "tenant-1")).rejects.toMatchObject({ statusCode: 402 });
    expect(companyCount.mock.calls[0][0].where).toEqual({ tenantId: "tenant-1" });
  });

  it("fails closed when the tenant row is missing", async () => {
    const { tx, companyCount } = transaction(null, 0);
    await expect(assertCompanyCapacity(tx, "missing")).rejects.toMatchObject({ statusCode: 401 });
    expect(companyCount).not.toHaveBeenCalled();
  });
});
