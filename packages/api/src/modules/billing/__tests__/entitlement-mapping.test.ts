import { describe, it, expect } from "vitest";
import {
  mapStripeSubscriptionUpdated,
  mapStripeSubscriptionDeleted,
  mapStripeChargeRefunded,
  mapIapVerify,
  mapAppleNotify,
  mapGoogleNotify,
  NEW_SALE_IAP_PRODUCT_MAP,
  resolveIapProductPlan,
  resolveStripePricePlan,
} from "../entitlement-mapping";
import type { VerifiedReceipt } from "../iap/apple";

const EVENT = { id: "evt_123", created: 1_800_000_000 }; // fixed unix seconds

function receipt(overrides: Partial<VerifiedReceipt> = {}): VerifiedReceipt {
  return {
    originalTransactionId: "orig-tx-1",
    status: "active",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2026-02-01T00:00:00Z"),
    autoRenew: true,
    ...overrides,
  };
}

describe("IAP catalog and additive receipt normalization", () => {
  it("offers exactly one canonical monthly product", () => {
    expect(NEW_SALE_IAP_PRODUCT_MAP).toEqual({
      "com.braavolabs.individual.monthly": "INDIVIDUAL",
    });
  });

  it("replays stable legacy SKUs deterministically and fails ambiguity closed", () => {
    expect(resolveIapProductPlan("com.braavolabs.creator.monthly")).toBe("INDIVIDUAL");
    expect(resolveIapProductPlan("com.braavolabs.creator.yearly")).toBe("INDIVIDUAL");
    expect(resolveIapProductPlan("com.braavolabs.team.monthly")).toBe("TEAM");
    expect(resolveIapProductPlan("com.braavolabs.team.yearly")).toBe("TEAM");
    expect(resolveIapProductPlan("com.braavolabs.pro.monthly")).toBe("TEAM");
    expect(resolveIapProductPlan("com.braavolabs.pro.yearly")).toBe("TEAM");
    expect(resolveIapProductPlan("com.braavolabs.business.monthly")).toBe("MANUAL_REVIEW");
    expect(resolveIapProductPlan("unknown.sku")).toBeUndefined();
  });
});

describe("Stripe price snapshot", () => {
  const snapshot = {
    individual: ["price_individual", "legacy_creator_yearly"],
    team: ["price_team", "legacy_pro_yearly"],
    ambiguousLegacy: ["legacy_business", "legacy_enterprise"],
  } as const;

  it("maps canonical and stable legacy aliases without exposing extra saleable plans", () => {
    expect(resolveStripePricePlan("price_individual", snapshot)).toBe("INDIVIDUAL");
    expect(resolveStripePricePlan("legacy_creator_yearly", snapshot)).toBe("INDIVIDUAL");
    expect(resolveStripePricePlan("price_team", snapshot)).toBe("TEAM");
    expect(resolveStripePricePlan("legacy_pro_yearly", snapshot)).toBe("TEAM");
  });

  it.each(["legacy_business", "legacy_enterprise", "unknown", undefined])(
    "fails ambiguous/unknown price %s closed",
    (priceId) => expect(resolveStripePricePlan(priceId, snapshot)).toBe("MANUAL_REVIEW"),
  );
});

describe("mapStripeSubscriptionUpdated", () => {
  it("active → renewal, carries the resolved plan + Stripe's own period end", () => {
    const out = mapStripeSubscriptionUpdated(
      EVENT,
      { id: "sub_1", status: "active", current_period_end: 1_802_000_000, cancel_at_period_end: false },
      "TEAM",
    );
    expect(out).toMatchObject({
      source: "stripe",
      streamId: "sub_1",
      sourceEventId: "evt_123",
      type: "renewal",
      planTier: "TEAM",
      autoRenew: true,
    });
    expect(out.sourceTimestamp).toEqual(new Date(1_800_000_000 * 1000));
    expect(out.expiresAt).toEqual(new Date(1_802_000_000 * 1000));
  });

  it("trialing cannot grant under the no-hosted-trial contract", () => {
    const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status: "trialing" }, "INDIVIDUAL");
    expect(out.type).toBe("revoke");
    expect(out.planTier).toBeNull();
  });

  it("cancel_at_period_end=true flips autoRenew off while still granting the current period", () => {
    const out = mapStripeSubscriptionUpdated(
      EVENT,
      { id: "sub_1", status: "active", cancel_at_period_end: true },
      "TEAM",
    );
    expect(out.type).toBe("renewal");
    expect(out.autoRenew).toBe(false);
  });

  it("past_due → grace, NOT an immediate FREE (the fix — old code blanket-downgraded this)", () => {
    const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status: "past_due" }, "TEAM");
    expect(out.type).toBe("grace");
    expect(out.planTier).toBeNull();
  });

  it("R2 fix (finding #1): past_due is `granting` too — carries expiresAt/autoRenew like renewal does, not null like the old revoke-only granting check produced", () => {
    const out = mapStripeSubscriptionUpdated(
      EVENT,
      { id: "sub_1", status: "past_due", current_period_end: 1_802_000_000, cancel_at_period_end: false },
      "TEAM",
    );
    expect(out.type).toBe("grace");
    expect(out.planTier).toBeNull(); // still null — foldStream's grace case never reads planTier
    expect(out.expiresAt).toEqual(new Date(1_802_000_000 * 1000)); // NOT null — this is the actual fix
    expect(out.autoRenew).toBe(true);
  });

  it.each(["canceled", "unpaid", "incomplete_expired", "paused", "incomplete"])(
    "status=%s → revoke (matches the old blanket-FREE fallback)",
    (status) => {
      const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status }, "TEAM");
      expect(out.type).toBe("revoke");
      expect(out.planTier).toBeNull();
      expect(out.expiresAt).toBeNull();
    },
  );
});

describe("mapStripeSubscriptionDeleted", () => {
  it("always revoke — immediate cutoff regardless of Stripe's period_end", () => {
    const out = mapStripeSubscriptionDeleted(EVENT, { id: "sub_1", status: "canceled" });
    expect(out).toMatchObject({
      source: "stripe",
      streamId: "sub_1",
      sourceEventId: "evt_123",
      type: "revoke",
      planTier: null,
      expiresAt: null,
      autoRenew: false,
    });
  });
});

describe("mapStripeChargeRefunded", () => {
  it("uses the caller-supplied streamId (tenant.stripeSubscriptionId), not derived from the charge", () => {
    const out = mapStripeChargeRefunded(EVENT, "sub_from_tenant_row");
    expect(out).toMatchObject({
      source: "stripe",
      streamId: "sub_from_tenant_row",
      type: "refund",
      planTier: null,
    });
  });
});

describe("mapIapVerify", () => {
  it("active → purchase, carries the resolved plan tier + real expiresAt", () => {
    const out = mapIapVerify("apple", receipt({ status: "active" }), "TEAM");
    expect(out).toMatchObject({
      source: "apple",
      streamId: expect.stringMatching(/^apple:[a-f0-9]{64}$/),
      type: "purchase",
      planTier: "TEAM",
      autoRenew: true,
    });
    expect(out!.expiresAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(out!.sourceEventId).not.toContain("orig-tx-1");
  });

  it("in_grace_period → grace and carries the tier for first-seen restore", () => {
    const out = mapIapVerify("google", receipt({ status: "in_grace_period" }), "TEAM");
    expect(out?.type).toBe("grace");
    expect(out?.planTier).toBe("TEAM");
  });

  it.each(["expired", "revoked", "paused"] as const)(
    "status=%s → terminal revoke on the same canonical stream",
    (status) => {
      const active = mapIapVerify("apple", receipt({ status: "active" }), "TEAM");
      const terminal = mapIapVerify("apple", receipt({ status }), "TEAM");

      expect(terminal).toMatchObject({
        source: "apple",
        streamId: active.streamId,
        type: "revoke",
        planTier: null,
        expiresAt: null,
        autoRenew: false,
      });
      expect(terminal.sourceEventId).not.toBe(active.sourceEventId);
    },
  );

  it("sourceEventId is stable across repeat calls for an UNCHANGED receipt (dedup property)", () => {
    const r = receipt({ status: "active" });
    const a = mapIapVerify("apple", r, "TEAM")!;
    const b = mapIapVerify("apple", r, "TEAM")!;
    expect(a.sourceEventId).toBe(b.sourceEventId);
  });

  it("sourceEventId CHANGES when expiresAt actually advances (a genuine renewal, not a dedupe-worthy repeat)", () => {
    const a = mapIapVerify("apple", receipt({ status: "active", expiresAt: new Date("2026-02-01T00:00:00Z") }), "TEAM")!;
    const b = mapIapVerify("apple", receipt({ status: "active", expiresAt: new Date("2026-03-01T00:00:00Z") }), "TEAM")!;
    expect(a.sourceEventId).not.toBe(b.sourceEventId);
  });

  it("R2 regression (finding #6a): sourceEventId CHANGES when only autoRenew flips (status/expiresAt unchanged) — a user toggling auto-renew off must not be silently deduped away", () => {
    const r = receipt({ status: "active", autoRenew: true });
    const a = mapIapVerify("apple", r, "TEAM")!;
    const b = mapIapVerify("apple", { ...r, autoRenew: false }, "TEAM")!;
    expect(a.sourceEventId).not.toBe(b.sourceEventId);
  });

  it("R2 regression (finding #6b): sourceEventId CHANGES on a same-expiresAt tier change (an immediate-upgrade proration that keeps the same period end) — must not collide with the pre-upgrade purchase event", () => {
    const r = receipt({ status: "active" });
    const a = mapIapVerify("apple", r, "INDIVIDUAL")!;
    const b = mapIapVerify("apple", r, "TEAM")!;
    expect(a.sourceEventId).not.toBe(b.sourceEventId);
  });
});

describe("mapAppleNotify / mapGoogleNotify — shared status vocabulary", () => {
  const note = { notificationUUID: "apple-uuid-1", signedDate: new Date("2026-01-15T00:00:00Z"), productId: "pro.monthly" };
  const parsed = { messageId: "pubsub-msg-1", publishTime: new Date("2026-01-15T00:00:00Z") };

  it("apple: active → renewal, carries verified.expiresAt (NOT note's own guess)", () => {
    const out = mapAppleNotify(note, receipt({ status: "active", expiresAt: new Date("2026-05-01T00:00:00Z") }), "TEAM");
    expect(out).toMatchObject({ source: "apple", streamId: expect.stringMatching(/^apple:[a-f0-9]{64}$/), sourceEventId: "apple-uuid-1", type: "renewal", planTier: "TEAM" });
    expect(out.expiresAt).toEqual(new Date("2026-05-01T00:00:00Z"));
    expect(out.sourceTimestamp).toEqual(new Date("2026-01-15T00:00:00Z"));
  });

  it("apple: in_grace_period → grace, keeps expiresAt and the tier for first-seen restore", () => {
    const out = mapAppleNotify(note, receipt({ status: "in_grace_period" }), "TEAM");
    expect(out.type).toBe("grace");
    expect(out.planTier).toBe("TEAM");
    expect(out.expiresAt).not.toBeNull();
  });

  it("apple: expired/revoked → revoke, clears expiresAt", () => {
    for (const status of ["expired", "revoked"] as const) {
      const out = mapAppleNotify(note, receipt({ status }), "TEAM");
      expect(out.type).toBe("revoke");
      expect(out.expiresAt).toBeNull();
    }
  });

  it("R2 fix (finding #10): paused → revoke, fail-closed (unreachable via today's apple.ts, exhaustiveness only) — Play's pause is 'stop access', not a payment-retry window, so it must not grant", () => {
    const out = mapAppleNotify(note, receipt({ status: "paused" }), "TEAM");
    expect(out.type).toBe("revoke");
    expect(out.expiresAt).toBeNull();
  });

  it("google: same status vocabulary, uses Pub/Sub messageId/publishTime as the ledger key", () => {
    const out = mapGoogleNotify(parsed, receipt({ status: "active" }), "INDIVIDUAL");
    expect(out).toMatchObject({ source: "google", sourceEventId: "pubsub-msg-1", type: "renewal", planTier: "INDIVIDUAL" });
    expect(out.sourceTimestamp).toEqual(new Date("2026-01-15T00:00:00Z"));
  });

  it("google: revoked → revoke", () => {
    const out = mapGoogleNotify(parsed, receipt({ status: "revoked" }), "INDIVIDUAL");
    expect(out.type).toBe("revoke");
    expect(out.planTier).toBeNull();
  });
});
