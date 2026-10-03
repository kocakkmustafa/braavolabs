import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../../../../lib/db", () => ({
  prisma: { activityLog: db },
}));

import {
  ensureManualReviewCase,
  getManualReviewCase,
  manualReviewCaseId,
  hasPendingManualReviewCases,
  transitionManualReviewCase,
} from "../manual-review.service";
import { iapCredentialDigest, iapCredentialReference } from "../../entitlement-mapping";

const RAW_APPLE_ID = "raw-apple-original-transaction-sentinel";
const TENANT = "tenant-a";

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pending-event",
    tenantId: TENANT,
    actor: "user-a",
    action: "billing.iap.manual_review.pending",
    resource: "iap_manual_review",
    resourceId: "iap_review_case",
    details: {
      schemaVersion: 1,
      state: "pending",
      provider: "apple",
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS",
      subscriptionId: "mobile-sub-a",
      identityRef: "apple:0123456789ab",
    },
    createdAt: new Date("2026-09-04T08:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.upsert.mockImplementation(async ({ create }: { create: unknown }) => create);
  db.findMany.mockResolvedValue([]);
  db.create.mockImplementation(async ({ data }: { data: unknown }) => data);
});

describe("provider-verified durable manual review", () => {
  it("creates one deterministic opaque pending case without persisting raw provider identity", async () => {
    const input = {
      tenantId: TENANT,
      actor: "user-a",
      provider: "apple" as const,
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS" as const,
      subscriptionId: "mobile-sub-a",
      providerIdentity: RAW_APPLE_ID,
    };

    const first = await ensureManualReviewCase(input);
    const second = await ensureManualReviewCase(input);

    expect(second.caseId).toBe(first.caseId);
    expect(first).toMatchObject({ state: "pending", targetTier: null });
    expect(first.caseId).toMatch(/^iap_review_[a-f0-9]{64}$/);
    expect(first.identityRef).toMatch(/^apple:[a-f0-9]{64}$/);
    expect(first.identityRef).toBe(iapCredentialDigest("apple", RAW_APPLE_ID));
    expect(first.identityRef).not.toBe(iapCredentialDigest("google", RAW_APPLE_ID));
    expect(first.identityRef).not.toBe(iapCredentialReference("apple", RAW_APPLE_ID));
    expect(db.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(db.upsert.mock.calls)).not.toContain(RAW_APPLE_ID);
  });

  it("idempotently appends provider-state observations and reduces the latest status without changing a terminal decision", async () => {
    const input = {
      tenantId: TENANT,
      actor: "apple-asn",
      provider: "apple" as const,
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS" as const,
      subscriptionId: "mobile-sub-a",
      providerIdentity: RAW_APPLE_ID,
      providerStatus: "active",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      autoRenew: true,
    };
    await ensureManualReviewCase(input);
    await ensureManualReviewCase(input);

    const providerWrites = db.upsert.mock.calls
      .map(([args]) => args)
      .filter((args: any) => args.create.action.endsWith(".provider_state"));
    expect(providerWrites).toHaveLength(2);
    expect(providerWrites[0].where.id).toBe(providerWrites[1].where.id);
    expect(JSON.stringify(providerWrites)).not.toContain(RAW_APPLE_ID);

    db.findMany.mockResolvedValue([
      pendingRow({
        details: {
          ...pendingRow().details,
          identityRef: iapCredentialDigest("apple", RAW_APPLE_ID),
          providerStatus: "active",
          expiresAt: "2026-10-01T00:00:00.000Z",
          autoRenew: true,
        },
      }),
      pendingRow({
        id: "decision-event",
        details: {
          schemaVersion: 1,
          state: "approved_mapping",
          targetTier: "TEAM",
          reason: "verified",
        },
        createdAt: new Date("2026-09-04T09:00:00Z"),
      }),
      pendingRow({
        id: "provider-update",
        details: {
          schemaVersion: 1,
          kind: "provider_state",
          providerStatus: "inactive",
          expiresAt: "2026-10-01T00:00:00.000Z",
          autoRenew: false,
        },
        createdAt: new Date("2026-09-04T10:00:00Z"),
      }),
    ]);
    await expect(getManualReviewCase(TENANT, "iap_review_case")).resolves.toMatchObject({
      state: "approved_mapping",
      targetTier: "TEAM",
      providerStatus: "inactive",
      autoRenew: false,
    });
  });

  it("reads only the requested tenant and reduces append-only lifecycle events", async () => {
    db.findMany.mockResolvedValue([
      pendingRow(),
      pendingRow({
        id: "decision-event",
        action: "billing.iap.manual_review.approved_mapping",
        details: {
          schemaVersion: 1,
          state: "approved_mapping",
          targetTier: "TEAM",
          reason: "verified historical enterprise contract",
        },
        createdAt: new Date("2026-09-04T09:00:00Z"),
      }),
    ]);

    const result = await getManualReviewCase(TENANT, "iap_review_case");

    expect(result).toMatchObject({ state: "approved_mapping", targetTier: "TEAM" });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: TENANT, resourceId: "iap_review_case" }),
    }));
  });

  it.each(["approved_mapping", "rejected", "expired"] as const)(
    "allows the one-way pending → %s transition and records reason append-only",
    async (state) => {
      db.findMany.mockResolvedValue([pendingRow()]);

      const result = await transitionManualReviewCase({
        tenantId: TENANT,
        actor: "operator-a",
        caseId: "iap_review_case",
        state,
        targetTier: state === "approved_mapping" ? "TEAM" : undefined,
        reason: "provider history reviewed",
      });

      expect(result.state).toBe(state);
      expect(db.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT,
          actor: "operator-a",
          resourceId: "iap_review_case",
          details: expect.objectContaining({ state, reason: "provider history reviewed" }),
        }),
      });
    },
  );

  it("rejects terminal-to-terminal transitions and approved mappings without a target tier", async () => {
    db.findMany.mockResolvedValue([
      pendingRow(),
      pendingRow({
        action: "billing.iap.manual_review.rejected",
        details: { schemaVersion: 1, state: "rejected", reason: "not eligible" },
      }),
    ]);

    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: "changed mind",
    })).rejects.toMatchObject({ statusCode: 409 });

    db.findMany.mockResolvedValue([pendingRow()]);
    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "approved_mapping",
      reason: "missing mapping",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("treats an exact sequential terminal replay as idempotent but rejects a conflicting replay", async () => {
    db.findMany.mockResolvedValue([
      pendingRow(),
      pendingRow({
        id: "decision-event",
        action: "billing.iap.manual_review.approved_mapping",
        details: {
          schemaVersion: 1,
          state: "approved_mapping",
          targetTier: "TEAM",
          reason: "verified",
        },
      }),
    ]);

    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: "verified",
    })).resolves.toMatchObject({ state: "approved_mapping", targetTier: "TEAM" });
    expect(db.create).not.toHaveBeenCalled();

    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "approved_mapping",
      targetTier: "INDIVIDUAL",
      reason: "verified",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("denies a case that is not visible inside the authenticated tenant", async () => {
    db.findMany.mockResolvedValue([]);

    await expect(transitionManualReviewCase({
      tenantId: "tenant-other",
      actor: "operator-other",
      caseId: "iap_review_case",
      state: "rejected",
      reason: "not this tenant's case",
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-other", resourceId: "iap_review_case" }),
    }));
    expect(db.create).not.toHaveBeenCalled();
  });

  it("reports a pending case from the authenticated tenant as visible", async () => {
    db.findMany.mockResolvedValue([pendingRow()]);

    await expect(hasPendingManualReviewCases(TENANT)).resolves.toBe(true);
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: TENANT, resource: "iap_manual_review" }),
    }));
  });

  it.each(["approved_mapping", "rejected", "expired"] as const)(
    "does not report a terminal %s case as pending",
    async (state) => {
      db.findMany.mockResolvedValue([
        pendingRow(),
        pendingRow({
          id: `decision-${state}`,
          action: `billing.iap.manual_review.${state}`,
          details: {
            schemaVersion: 1,
            state,
            targetTier: state === "approved_mapping" ? "TEAM" : null,
            reason: "Provider history reviewed by the billing owner.",
          },
          createdAt: new Date("2026-09-04T09:00:00Z"),
        }),
      ]);

      await expect(hasPendingManualReviewCases(TENANT)).resolves.toBe(false);
    },
  );

  it("fails closed when pending-case visibility cannot be read", async () => {
    db.findMany.mockRejectedValue(new Error("activity store unavailable"));

    await expect(hasPendingManualReviewCases(TENANT)).rejects.toThrow("activity store unavailable");
  });

  it.each([
    "Provider history reviewed and ownership confirmed.",
    "Sağlayıcı geçmişi incelendi ve hesap sahipliği doğrulandı.",
    "Receipt: verified by provider.",
    "verified",
  ])("accepts a bounded human review note: %s", async (reason) => {
    db.findMany.mockResolvedValue([pendingRow()]);

    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "rejected",
      reason,
    })).resolves.toMatchObject({ state: "rejected", reason });
  });

  it.each([
    ["unlabelled Google token", "gp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"],
    ["unlabelled Apple transaction id", "490001234567890"],
    ["hex digest", "a".repeat(64)],
    ["base64 receipt", Buffer.from("receipt-material-that-must-not-be-stored").toString("base64")],
    ["JWT-like token", `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`],
    ["embedded JWT-like token", `Token (${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}) was supplied.`],
    ["labelled token", "purchaseToken=raw-secret"],
    ["service-account JSON", '{"type":"service_account","private_key":"raw-secret"}'],
    ["private key", "-----BEGIN PRIVATE KEY----- raw-secret -----END PRIVATE KEY-----"],
  ])("rejects %s before any ActivityLog read or write", async (_label, reason) => {
    await expect(transitionManualReviewCase({
      tenantId: TENANT,
      actor: "operator-a",
      caseId: "iap_review_case",
      state: "rejected",
      reason,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.findMany).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });
});


describe("Google lineage review contract", () => {
  const input = {
    tenantId: TENANT, actor: "google-rtdn", provider: "google" as const,
    productId: "com.braavolabs.business.monthly", internalPlan: "BUSINESS" as const,
    subscriptionId: "google-sub", providerIdentity: "local-google-token-sentinel",
    reviewKind: "google_lineage" as const, reasonCode: "GOOGLE_LINEAGE_UNKNOWN" as const,
    providerStatus: "expired", expiresAt: new Date("2026-10-01T00:00:00Z"), autoRenew: false,
  };
  const lineageRow = () => pendingRow({ details: { ...pendingRow().details, provider: "google",
    reviewKind: "google_lineage", reasonCode: "GOOGLE_LINEAGE_UNKNOWN" } });

  it("uses a distinct stable domain and creates pending review even for terminal provider state", async () => {
    const { reviewKind, reasonCode, ...legacy } = input;
    const first = await ensureManualReviewCase(input);
    const second = await ensureManualReviewCase({ ...input, actor: "other", subscriptionId: "other" });
    expect(first.caseId).toBe(second.caseId);
    expect(first.caseId).not.toBe(manualReviewCaseId(legacy));
    expect(manualReviewCaseId(legacy)).toBe(manualReviewCaseId({ ...legacy, reviewKind: "catalog_mapping" }));
    expect(first).toMatchObject({ reviewKind, reasonCode, state: "pending", targetTier: null, providerStatus: "expired" });
    expect(db.create).not.toHaveBeenCalled();
    const writes = db.upsert.mock.calls.map(([args]) => args);
    expect(writes[0].where.id).toBe(writes[2].where.id);
    expect(writes[0].create.details).toMatchObject({ reviewKind, reasonCode });
    expect(JSON.stringify(writes)).not.toContain(input.providerIdentity);
    expect(writes.every((args: any) => args.create.resource === "iap_manual_review")).toBe(true);
  });

  it("defaults legacy records to catalog mapping", async () => {
    db.findMany.mockResolvedValue([pendingRow()]);
    await expect(getManualReviewCase(TENANT, "iap_review_case")).resolves.toMatchObject({ reviewKind: "catalog_mapping", reasonCode: null });
  });

  it("blocks catalog mapping approval without writing a decision", async () => {
    db.findMany.mockResolvedValue([lineageRow()]);
    await expect(transitionManualReviewCase({ tenantId: TENANT, actor: "operator", caseId: "iap_review_case",
      state: "approved_mapping", targetTier: "TEAM", reason: "Catalog verified" })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.create).not.toHaveBeenCalled();
  });

  it.each(["rejected", "expired"] as const)("preserves %s replay idempotence", async (state) => {
    db.findMany.mockResolvedValue([lineageRow()]);
    const decision = { tenantId: TENANT, actor: "operator", caseId: "iap_review_case", state, reason: "Ancestry remains unverified" };
    await expect(transitionManualReviewCase(decision)).resolves.toMatchObject({ state, reviewKind: "google_lineage", targetTier: null });
    const persisted = db.create.mock.calls[0][0].data;
    expect(persisted.details).toMatchObject({ reviewKind: "google_lineage", reasonCode: "GOOGLE_LINEAGE_UNKNOWN" });
    db.findMany.mockResolvedValue([lineageRow(), pendingRow({ ...persisted, createdAt: new Date() })]);
    await expect(transitionManualReviewCase(decision)).resolves.toMatchObject({ state });
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reviewKind: "unknown", reasonCode: undefined },
    { reviewKind: "google_lineage", reasonCode: "unknown" },
    { reviewKind: "catalog_mapping", reasonCode: "GOOGLE_LINEAGE_UNKNOWN" },
    { reviewKind: "google_lineage", reasonCode: undefined },
  ])("fails closed for invalid metadata %j", async (metadata) => {
    await expect(ensureManualReviewCase({ ...input, ...metadata } as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.upsert).not.toHaveBeenCalled();
    db.findMany.mockResolvedValue([pendingRow({ details: { ...lineageRow().details, ...metadata } })]);
    await expect(getManualReviewCase(TENANT, "iap_review_case")).rejects.toMatchObject({ statusCode: 500 });
  });

  it("fails closed for a persisted lineage mapping bypass", async () => {
    db.findMany.mockResolvedValue([lineageRow(), pendingRow({ details: { state: "approved_mapping", targetTier: "TEAM" } })]);
    await expect(getManualReviewCase(TENANT, "iap_review_case")).rejects.toMatchObject({ statusCode: 500 });
  });
});
