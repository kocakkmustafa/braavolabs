import { describe, it, expect } from "vitest";
import {
  mapStripeSubscriptionUpdated,
  mapStripeSubscriptionDeleted,
  mapStripeChargeRefunded,
  mapIapVerify,
  mapAppleNotify,
  mapGoogleNotify,
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

describe("mapStripeSubscriptionUpdated", () => {
  it("active → renewal, carries the resolved plan + Stripe's own period end", () => {
    const out = mapStripeSubscriptionUpdated(
      EVENT,
      { id: "sub_1", status: "active", current_period_end: 1_802_000_000, cancel_at_period_end: false },
      "PRO",
    );
    expect(out).toMatchObject({
      source: "stripe",
      streamId: "sub_1",
      sourceEventId: "evt_123",
      type: "renewal",
      planTier: "PRO",
      autoRenew: true,
    });
    expect(out.sourceTimestamp).toEqual(new Date(1_800_000_000 * 1000));
    expect(out.expiresAt).toEqual(new Date(1_802_000_000 * 1000));
  });

  it("trialing → renewal (same as active)", () => {
    const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status: "trialing" }, "CREATOR");
    expect(out.type).toBe("renewal");
    expect(out.planTier).toBe("CREATOR");
  });

  it("cancel_at_period_end=true flips autoRenew off while still granting the current period", () => {
    const out = mapStripeSubscriptionUpdated(
      EVENT,
      { id: "sub_1", status: "active", cancel_at_period_end: true },
      "PRO",
    );
    expect(out.type).toBe("renewal");
    expect(out.autoRenew).toBe(false);
  });

  it("past_due → grace, NOT an immediate FREE (the fix — old code blanket-downgraded this)", () => {
    const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status: "past_due" }, "PRO");
    expect(out.type).toBe("grace");
    expect(out.planTier).toBeNull();
  });

  it.each(["canceled", "unpaid", "incomplete_expired", "paused", "incomplete"])(
    "status=%s → revoke (matches the old blanket-FREE fallback)",
    (status) => {
      const out = mapStripeSubscriptionUpdated(EVENT, { id: "sub_1", status }, "PRO");
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
    const out = mapIapVerify("apple", receipt({ status: "active" }), "BUSINESS");
    expect(out).toMatchObject({
      source: "apple",
      streamId: "orig-tx-1",
      type: "purchase",
      planTier: "BUSINESS",
      autoRenew: true,
    });
    expect(out!.expiresAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("in_grace_period → grace, no planTier", () => {
    const out = mapIapVerify("google", receipt({ status: "in_grace_period" }), "PRO");
    expect(out?.type).toBe("grace");
    expect(out?.planTier).toBeNull();
  });

  it.each(["expired", "revoked", "paused"] as const)(
    "status=%s → null (matches the existing handler's exact no-op for non-active/grace)",
    (status) => {
      expect(mapIapVerify("apple", receipt({ status }), "PRO")).toBeNull();
    },
  );

  it("sourceEventId is stable across repeat calls for an UNCHANGED receipt (dedup property)", () => {
    const r = receipt({ status: "active" });
    const a = mapIapVerify("apple", r, "PRO")!;
    const b = mapIapVerify("apple", r, "PRO")!;
    expect(a.sourceEventId).toBe(b.sourceEventId);
  });

  it("sourceEventId CHANGES when expiresAt actually advances (a genuine renewal, not a dedupe-worthy repeat)", () => {
    const a = mapIapVerify("apple", receipt({ status: "active", expiresAt: new Date("2026-02-01T00:00:00Z") }), "PRO")!;
    const b = mapIapVerify("apple", receipt({ status: "active", expiresAt: new Date("2026-03-01T00:00:00Z") }), "PRO")!;
    expect(a.sourceEventId).not.toBe(b.sourceEventId);
  });
});

describe("mapAppleNotify / mapGoogleNotify — shared status vocabulary", () => {
  const note = { notificationUUID: "apple-uuid-1", signedDate: new Date("2026-01-15T00:00:00Z"), productId: "pro.monthly" };
  const parsed = { messageId: "pubsub-msg-1", publishTime: new Date("2026-01-15T00:00:00Z") };

  it("apple: active → renewal, carries verified.expiresAt (NOT note's own guess)", () => {
    const out = mapAppleNotify(note, receipt({ status: "active", expiresAt: new Date("2026-05-01T00:00:00Z") }), "PRO");
    expect(out).toMatchObject({ source: "apple", streamId: "orig-tx-1", sourceEventId: "apple-uuid-1", type: "renewal", planTier: "PRO" });
    expect(out.expiresAt).toEqual(new Date("2026-05-01T00:00:00Z"));
    expect(out.sourceTimestamp).toEqual(new Date("2026-01-15T00:00:00Z"));
  });

  it("apple: in_grace_period → grace, keeps expiresAt (still granting) but no planTier", () => {
    const out = mapAppleNotify(note, receipt({ status: "in_grace_period" }), "PRO");
    expect(out.type).toBe("grace");
    expect(out.planTier).toBeNull();
    expect(out.expiresAt).not.toBeNull();
  });

  it("apple: expired/revoked → revoke, clears expiresAt", () => {
    for (const status of ["expired", "revoked"] as const) {
      const out = mapAppleNotify(note, receipt({ status }), "PRO");
      expect(out.type).toBe("revoke");
      expect(out.expiresAt).toBeNull();
    }
  });

  it("apple: paused → grace (defensive — unreachable via today's apple.ts, exhaustiveness only)", () => {
    const out = mapAppleNotify(note, receipt({ status: "paused" }), "PRO");
    expect(out.type).toBe("grace");
  });

  it("google: same status vocabulary, uses Pub/Sub messageId/publishTime as the ledger key", () => {
    const out = mapGoogleNotify(parsed, receipt({ status: "active" }), "CREATOR");
    expect(out).toMatchObject({ source: "google", sourceEventId: "pubsub-msg-1", type: "renewal", planTier: "CREATOR" });
    expect(out.sourceTimestamp).toEqual(new Date("2026-01-15T00:00:00Z"));
  });

  it("google: revoked → revoke", () => {
    const out = mapGoogleNotify(parsed, receipt({ status: "revoked" }), "CREATOR");
    expect(out.type).toBe("revoke");
    expect(out.planTier).toBeNull();
  });
});
