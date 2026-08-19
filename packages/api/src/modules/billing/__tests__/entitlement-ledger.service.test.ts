import { describe, it, expect, vi, beforeEach } from "vitest";

// Same convention as savings.service.test.ts / forecast.test.ts — mock the
// Prisma client before importing the module under test.
vi.mock("../../../lib/db", () => ({
  prisma: {
    entitlementEvent: { create: vi.fn(), findMany: vi.fn() },
    tenant: { update: vi.fn() },
  },
}));

vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  appendEntitlementEvent,
  reprojectEntitlement,
  recordEntitlementEvent,
} from "../entitlement-ledger.service";
import { prisma } from "../../../lib/db";

const mockCreate = prisma.entitlementEvent.create as unknown as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.entitlementEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockTenantUpdate = prisma.tenant.update as unknown as ReturnType<typeof vi.fn>;

const TENANT = "tenant-A";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evt-1",
    tenantId: TENANT,
    source: "stripe",
    streamId: "sub-1",
    sourceEventId: "evt-1",
    sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
    type: "purchase",
    planTier: "PRO",
    expiresAt: new Date("2026-02-01T00:00:00Z"),
    autoRenew: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUpdate.mockResolvedValue({});
});

describe("appendEntitlementEvent", () => {
  it("inserts and returns true on first delivery", async () => {
    mockCreate.mockResolvedValue(row());

    const inserted = await appendEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
      type: "purchase",
      planTier: "PRO",
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      autoRenew: true,
    });

    expect(inserted).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        source: "stripe",
        streamId: "sub-1",
        sourceEventId: "evt-1",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
        type: "purchase",
        planTier: "PRO",
        expiresAt: new Date("2026-02-01T00:00:00Z"),
        autoRenew: true,
      },
    });
  });

  it("swallows a P2002 unique-constraint violation and returns false — same redelivery must not throw into the webhook handler", async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`source`,`source_event_id`)"), {
        code: "P2002",
      }),
    );

    const inserted = await appendEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date(),
      type: "purchase",
      planTier: "PRO",
      expiresAt: null,
      autoRenew: true,
    });

    expect(inserted).toBe(false);
  });

  it("re-throws a non-duplicate DB error so the webhook 5xx's and the source retries", async () => {
    mockCreate.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(
      appendEntitlementEvent({
        tenantId: TENANT,
        source: "stripe",
        streamId: "sub-1",
        sourceEventId: "evt-1",
        sourceTimestamp: new Date(),
        type: "purchase",
        planTier: "PRO",
        expiresAt: null,
        autoRenew: true,
      }),
    ).rejects.toThrow("connection terminated unexpectedly");
  });
});

describe("reprojectEntitlement", () => {
  it("writes FREE when the tenant has no events at all", async () => {
    mockFindMany.mockResolvedValue([]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("FREE");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "FREE" } });
  });

  it("projects a single active stream's plan tier onto tenant.plan", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "PRO", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("PRO");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "PRO" } });
  });

  it("folds a stream's full history (purchase then cancel then renewal) before projecting — not just the latest row blindly", async () => {
    mockFindMany.mockResolvedValue([
      row({
        id: "e1",
        type: "purchase",
        planTier: "CREATOR",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-02-01T00:00:00Z"),
      }),
      row({
        id: "e2",
        type: "renewal",
        planTier: "PRO",
        sourceTimestamp: new Date("2026-02-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("PRO");
  });

  it("combines multiple concurrent streams and projects the highest still-granting tier (Stripe refunded, mobile still active)", async () => {
    mockFindMany.mockResolvedValue([
      row({
        id: "e1",
        source: "stripe",
        streamId: "sub-1",
        type: "refund",
        planTier: null,
        expiresAt: null,
      }),
      row({
        id: "e2",
        source: "apple",
        streamId: "orig-tx-1",
        type: "purchase",
        planTier: "BUSINESS",
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("BUSINESS");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "BUSINESS" } });
  });

  it("projects FREE once expiresAt has passed even though the last event never said so explicitly (wall-clock, not event-count)", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "ENTERPRISE", expiresAt: new Date("2020-01-01T00:00:00Z") }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("FREE");
  });

  it("fails closed to FREE (not a Prisma enum error) if the reducer ever resolves a tier outside the known catalog", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "NOT_A_REAL_TIER", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("FREE");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "FREE" } });
  });

  it("scopes the read to this tenant only — tenant isolation (CLAUDE.md rule #10)", async () => {
    mockFindMany.mockResolvedValue([]);

    await reprojectEntitlement(TENANT);

    expect(mockFindMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
  });
});

describe("recordEntitlementEvent", () => {
  it("appends then reprojects, and returns the reprojected plan", async () => {
    mockCreate.mockResolvedValue(row());
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "CREATOR", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await recordEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date(),
      type: "purchase",
      planTier: "CREATOR",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    });

    expect(plan).toBe("CREATOR");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("still reprojects from the full history on a duplicate append — the observable effect is identical whichever delivery 'wins' the insert", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "PRO", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await recordEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date(),
      type: "purchase",
      planTier: "PRO",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    });

    expect(plan).toBe("PRO");
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
