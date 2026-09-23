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
    entitlementEvent: { create: vi.fn(), createMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    googlePurchaseAlias: { findFirst: vi.fn() },
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
  getEntitlementProjection,
  reprojectEntitlement,
  recordEntitlementEvent,
  recordGoogleEntitlementWithDecision,
} from "../entitlement-ledger.service";
import { iapLedgerStreamId, mapIapVerify } from "../entitlement-mapping";
import { prisma } from "../../../lib/db";

const mockCreate = prisma.entitlementEvent.create as unknown as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.entitlementEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.entitlementEvent.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockCreateMany = prisma.entitlementEvent.createMany as unknown as ReturnType<typeof vi.fn>;
const mockAliasFindFirst = prisma.googlePurchaseAlias.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockQueryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
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

describe("getEntitlementProjection", () => {
  it("reads the same all-stream projection without mutating tenant.plan", async () => {
    mockFindMany.mockResolvedValue([
      row({ id: "individual", streamId: "individual", planTier: "INDIVIDUAL", expiresAt: new Date(Date.now() + 172_800_000) }),
      row({ id: "team", source: "google", streamId: "team", planTier: "TEAM", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const projection = await getEntitlementProjection(TENANT);

    expect(projection).toMatchObject({
      effectiveTier: "TEAM",
      source: "google",
      streamId: "team",
    });
    expect(mockFindMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    expect(mockTenantUpdate).not.toHaveBeenCalled();
  });

  it("keeps manual-review-only history visible without granting paid access", async () => {
    mockFindMany.mockResolvedValue([
      row({ id: "review", planTier: "MANUAL_REVIEW", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    await expect(getEntitlementProjection(TENANT)).resolves.toMatchObject({
      effectiveTier: null,
      winner: null,
      hasManualReview: true,
    });
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

  it("fences a replaced Google root and projects the newer grant even when an old revoke has a later provider timestamp", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    const newIdentity = `google:${"b".repeat(64)}`;
    const streamId = iapLedgerStreamId("google", rootIdentity);
    const aliases = new Set([rootIdentity]);
    const events: ReturnType<typeof row>[] = [];
    const verified = {
      originalTransactionId: rootIdentity,
      status: "active" as const,
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    };
    const oldGrant = mapIapVerify("google", verified, "TEAM", rootIdentity);
    const replacementGrant = mapIapVerify("google", verified, "TEAM", newIdentity);
    expect(replacementGrant.sourceEventId).not.toBe(oldGrant.sourceEventId);
    events.push(row({ ...oldGrant, id: "old-grant", tenantId: TENANT }));
    const readStartedAt = new Date("2026-08-25T20:00:00Z");
    mockQueryRaw.mockResolvedValue([{ id: "mobile-sub-google", last_verified_at: readStartedAt }]);
    mockAliasFindFirst.mockImplementation(async ({ where }: any) =>
      [...aliases].find((digest) => !where.tokenDigest.notIn.includes(digest))
        ? { tokenDigest: newIdentity }
        : null);
    mockFindFirst.mockImplementation(async ({ where }: any) => {
      if (where.sourceEventId) {
        const found = events.find((event) => event.sourceEventId === where.sourceEventId);
        return found ? { id: found.id, streamId: found.streamId } : null;
      }
      const latest = [...events].sort((a, b) =>
        b.sourceTimestamp.getTime() - a.sourceTimestamp.getTime())[0];
      return latest ? { id: latest.id, sourceTimestamp: latest.sourceTimestamp, type: latest.type, sourceEventId: latest.sourceEventId } : null;
    });
    mockCreateMany.mockImplementation(async ({ data }: any) => {
      const [candidate] = data;
      if (events.some((event) => event.sourceEventId === candidate.sourceEventId)) {
        return { count: 0 };
      }
      events.push(row({ ...candidate, id: `event-${events.length + 1}` }));
      return { count: 1 };
    });
    mockFindMany.mockImplementation(async () => events);

    const oldEvent = {
      tenantId: TENANT,
      source: "google" as const,
      streamId,
      sourceEventId: "late-old-voided",
      sourceTimestamp: new Date(Date.now() + 60_000),
      type: "revoke" as const,
      planTier: null,
      expiresAt: null,
      autoRenew: false,
    };
    const oldFence = {
      subscriptionId: "mobile-sub-google",
      rootIdentity,
      verifiedAliases: [rootIdentity],
      readCompletedAt: readStartedAt,
    };
    const newFence = {
      ...oldFence,
      verifiedAliases: [newIdentity, rootIdentity],
    };

    expect(await recordEntitlementEvent(oldEvent, oldFence)).toBe("MANUAL_REVIEW");
    aliases.add(newIdentity); // A new-token claim commits after the old append.
    const newEvent = {
      ...replacementGrant,
      tenantId: TENANT,
      sourceTimestamp: new Date(Date.now() - 60_000),
    };
    expect(await recordEntitlementEvent(newEvent, newFence)).toBe("TEAM");
    expect(events[2]!.sourceTimestamp.getTime()).toBeGreaterThan(events[1]!.sourceTimestamp.getTime());
    expect(await getEntitlementProjection(TENANT)).toMatchObject({ effectiveTier: "TEAM" });

    // A late old-token retry observes the new alias under the same root lock.
    expect(await recordEntitlementEvent({ ...oldEvent, sourceEventId: "old-retry" }, oldFence))
      .toBeNull();
    expect(events).toHaveLength(3);
    expect(await getEntitlementProjection(TENANT)).toMatchObject({ effectiveTier: "TEAM" });
    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    expect(mockAliasFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenDigest: { notIn: [rootIdentity] } }),
    }));
  });

  it("records a same-token reactivation after a revoke exactly once", async () => {
    const rootIdentity = `google:${"c".repeat(64)}`;
    const readStartedAt = new Date("2026-08-25T20:00:00Z");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const grant = {
      tenantId: TENANT,
      source: "google" as const,
      streamId: iapLedgerStreamId("google", rootIdentity),
      sourceEventId: "same-token-active-digest",
      sourceTimestamp: new Date("2026-08-25T20:00:00Z"),
      type: "purchase" as const,
      planTier: "TEAM",
      expiresAt,
      autoRenew: true,
    };
    const events = [
      row({ ...grant, id: "first-grant" }),
      row({ ...grant, id: "terminal-revoke", sourceEventId: "rtdn-revoke", type: "revoke", planTier: null, expiresAt: null, autoRenew: false, sourceTimestamp: new Date("2026-08-25T20:01:00Z") }),
    ];
    mockQueryRaw.mockResolvedValue([{ id: "mobile-sub-google", last_verified_at: readStartedAt }]);
    mockAliasFindFirst.mockResolvedValue(null);
    mockFindFirst.mockImplementation(async ({ where }: any) => {
      if (where.sourceEventId) {
        const found = events.find((event) => event.sourceEventId === where.sourceEventId);
        return found ? { id: found.id, streamId: found.streamId } : null;
      }
      const latest = events.at(-1)!;
      return { id: latest.id, sourceTimestamp: latest.sourceTimestamp, type: latest.type, sourceEventId: latest.sourceEventId };
    });
    mockCreateMany.mockImplementation(async ({ data }: any) => {
      const candidate = data[0];
      if (events.some((event) => event.sourceEventId === candidate.sourceEventId)) return { count: 0 };
      events.push(row({ ...candidate, id: `event-${events.length + 1}` }));
      return { count: 1 };
    });
    mockFindMany.mockImplementation(async () => events);
    const fence = { subscriptionId: "mobile-sub-google", rootIdentity, verifiedAliases: [rootIdentity], readCompletedAt: readStartedAt };

    expect(await recordEntitlementEvent(grant, fence)).toBe("TEAM");
    expect(events).toHaveLength(3);
    expect(events[2]!.sourceEventId).toBe(`${grant.sourceEventId}:after:terminal-revoke`);
    expect(events[2]!.sourceTimestamp.getTime()).toBeGreaterThan(events[1]!.sourceTimestamp.getTime());
    expect(await recordEntitlementEvent(grant, fence)).toBe("TEAM");
    expect(events).toHaveLength(3);
  });

  it("rejects an older provider read before a stale Google grant or review decision is written", async () => {
    const rootIdentity = `google:${"d".repeat(64)}`;
    const earlierRead = new Date("2026-08-25T20:00:00Z");
    mockQueryRaw.mockResolvedValue([{
      id: "mobile-sub-google",
      last_verified_at: new Date("2026-08-25T20:01:00Z"),
    }]);
    const decide = vi.fn();
    const result = recordGoogleEntitlementWithDecision({
      tenantId: TENANT,
      source: "google",
      streamId: iapLedgerStreamId("google", rootIdentity),
      sourceEventId: "older-active",
      sourceTimestamp: earlierRead,
      type: "purchase",
      planTier: "TEAM",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    }, {
      subscriptionId: "mobile-sub-google",
      rootIdentity,
      verifiedAliases: [rootIdentity],
      readCompletedAt: earlierRead,
    }, decide);

    await expect(result).rejects.toMatchObject({
      statusCode: 409,
      message: "Google verification was superseded; retry",
    });
    expect(decide).not.toHaveBeenCalled();
    expect(mockAliasFindFirst).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("never runs a Google manual-review decision after a replacement alias wins the root fence", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    const event = {
      tenantId: TENANT,
      source: "google" as const,
      streamId: iapLedgerStreamId("google", rootIdentity),
      sourceEventId: "manual-review-grant",
      sourceTimestamp: new Date(),
      type: "purchase" as const,
      planTier: "TEAM",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    };
    const readStartedAt = new Date("2026-08-25T20:00:00Z");
    mockQueryRaw.mockResolvedValue([{ id: "mobile-sub-google", last_verified_at: readStartedAt }]);
    mockAliasFindFirst.mockResolvedValue({ tokenDigest: `google:${"b".repeat(64)}` });
    const decide = vi.fn().mockResolvedValue({ state: "approved_mapping" });

    const result = await recordGoogleEntitlementWithDecision(event, {
      subscriptionId: "mobile-sub-google",
      rootIdentity,
      verifiedAliases: [rootIdentity],
      readCompletedAt: readStartedAt,
    }, decide);

    expect(result).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(mockTenantUpdate).not.toHaveBeenCalled();
  });

  it("runs an eligible Google review decision before its grant append under the root fence", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    const event = {
      tenantId: TENANT,
      source: "google" as const,
      streamId: iapLedgerStreamId("google", rootIdentity),
      sourceEventId: "approved-manual-review",
      sourceTimestamp: new Date(),
      type: "purchase" as const,
      planTier: "TEAM",
      expiresAt: new Date(Date.now() + 86_400_000),
      autoRenew: true,
    };
    const readStartedAt = new Date("2026-08-25T20:00:00Z");
    mockQueryRaw.mockResolvedValue([{ id: "mobile-sub-google", last_verified_at: readStartedAt }]);
    mockAliasFindFirst.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue(null);
    mockCreateMany.mockResolvedValue({ count: 1 });
    mockFindMany.mockResolvedValue([row({ ...event, id: "approved-event" })]);
    const decide = vi.fn().mockResolvedValue({ state: "approved_mapping" });

    const result = await recordGoogleEntitlementWithDecision(event, {
      subscriptionId: "mobile-sub-google",
      rootIdentity,
      verifiedAliases: [rootIdentity],
      readCompletedAt: readStartedAt,
    }, decide);

    expect(result).toEqual({ decision: { state: "approved_mapping" }, plan: "TEAM" });
    expect(mockQueryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(mockAliasFindFirst.mock.invocationCallOrder[0]);
    expect(mockAliasFindFirst.mock.invocationCallOrder[0])
      .toBeLessThan(decide.mock.invocationCallOrder[0]);
    expect(decide.mock.invocationCallOrder[0])
      .toBeLessThan(mockCreateMany.mock.invocationCallOrder[0]);
  });
});
