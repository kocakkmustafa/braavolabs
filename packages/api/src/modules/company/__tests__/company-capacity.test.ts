import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { assertCompanyCapacity } from "../company-capacity";

function transaction(plan: string | null, count: number) {
  const query = vi.fn().mockResolvedValue(plan === null ? [] : [{ plan }]);
  const companyCount = vi.fn().mockResolvedValue(count);
  const tx = {
    $queryRaw: query,
    company: { count: companyCount },
  } as unknown as Prisma.TransactionClient;
  return { tx, query, companyCount };
}

describe("assertCompanyCapacity", () => {
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
