import { describe, it, expect, vi, beforeEach } from "vitest";

// Same convention as savings.service.test.ts / forecast.test.ts — mock the
// Prisma client before importing the module under test.
//
// tenantTx invokes the callback with the SAME mocked client as `tx` (so
// mockFindMany/mockTenantUpdate below are literally the same mock functions
// the transaction body calls — no separate tx-mock to keep in sync).
// $queryRaw (the FOR UPDATE row lock) is a no-op here — these are unit tests
// of the reduction/persistence LOGIC against a fake client, not a proof the
// lock actually serializes concurrent callers; that's what the live-DB demo
// script's concurrency scenario is for.
//
// `prisma.$transaction` is deliberately a THROWING stub. reprojectEntitlement
// must use tenantTx: the `tx` from a $transaction on the EXTENDED client is
// itself extended, so its model ops re-enter the RLS wrapper, open a second
// transaction on a different connection, and deadlock on the FOR UPDATE lock
// the outer transaction holds (reproduced against real Postgres). The previous
// double passed the same client back for BOTH, so it modelled neither the
// re-entry nor the deadlock and the bug was invisible to this suite — a test
// double that does not enforce reality's rule proves nothing.
vi.mock("../../../lib/db", () => {
  const client: any = {
    entitlementEvent: { create: vi.fn(), findMany: vi.fn() },
    tenant: { update: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  client.$transaction = vi.fn(() => {
    throw new Error(
      "prisma.$transaction must not be used here — its tx is EXTENDED and deadlocks against the FOR UPDATE lock. Use tenantTx (un-extended tx).",
    );
  });
  return {
    prisma: client,
    tenantTx: vi.fn((cb: (tx: unknown) => unknown) => cb(client)),
  };
});

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
    planTier: "TEAM",
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
      planTier: "TEAM",
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
        planTier: "TEAM",
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
      planTier: "TEAM",
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
        planTier: "TEAM",
        expiresAt: null,
        autoRenew: true,
      }),
    ).rejects.toThrow("connection terminated unexpectedly");
  });
});

describe("reprojectEntitlement", () => {
  it("writes MANUAL_REVIEW when the tenant has no events at all", async () => {
    mockFindMany.mockResolvedValue([]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("MANUAL_REVIEW");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "MANUAL_REVIEW" } });
  });

  it("projects a single active stream's plan tier onto tenant.plan", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "TEAM", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("TEAM");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "TEAM" } });
  });

  it("folds a stream's full history (purchase then cancel then renewal) before projecting — not just the latest row blindly", async () => {
    mockFindMany.mockResolvedValue([
      row({
        id: "e1",
        type: "purchase",
        planTier: "INDIVIDUAL",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-02-01T00:00:00Z"),
      }),
      row({
        id: "e2",
        type: "renewal",
        planTier: "TEAM",
        sourceTimestamp: new Date("2026-02-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("TEAM");
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
        planTier: "TEAM",
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("TEAM");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "TEAM" } });
  });

  it("projects MANUAL_REVIEW once expiresAt has passed", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "MANUAL_REVIEW", expiresAt: new Date("2020-01-01T00:00:00Z") }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("MANUAL_REVIEW");
  });

  it("fails closed to MANUAL_REVIEW if the reducer sees an unknown tier", async () => {
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "NOT_A_REAL_TIER", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await reprojectEntitlement(TENANT);

    expect(plan).toBe("MANUAL_REVIEW");
    expect(mockTenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT }, data: { plan: "MANUAL_REVIEW" } });
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
      row({ type: "purchase", planTier: "INDIVIDUAL", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await recordEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date(),
      type: "purchase",
      planTier: "INDIVIDUAL",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    });

    expect(plan).toBe("INDIVIDUAL");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("still reprojects from the full history on a duplicate append — the observable effect is identical whichever delivery 'wins' the insert", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    mockFindMany.mockResolvedValue([
      row({ type: "purchase", planTier: "TEAM", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const plan = await recordEntitlementEvent({
      tenantId: TENANT,
      source: "stripe",
      streamId: "sub-1",
      sourceEventId: "evt-1",
      sourceTimestamp: new Date(),
      type: "purchase",
      planTier: "TEAM",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    });

    expect(plan).toBe("TEAM");
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
