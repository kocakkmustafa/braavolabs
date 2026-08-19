/**
 * BR-P0-003 — entitlement reducer contract tests.
 *
 * The reducer is a PURE function: given the same set of events, in ANY
 * order, it must fold to the SAME final state. This is the property that
 * makes "duplicate/out-of-order events → deterministic entitlement"
 * provable — no database, no mocks, just data in and data out.
 *
 * Two-stage design:
 *   1. foldStream(events) — folds ONE subscription's event history
 *      (e.g. one Stripe subscription, or one Apple originalTransactionId)
 *      into that stream's current state.
 *   2. combineStreams(states) — a tenant can have more than one stream
 *      (e.g. a Stripe web subscription AND a mobile IAP subscription
 *      concurrently) — picks the tenant's actual entitlement as the BEST
 *      (highest-tier) currently-active stream, mirroring the existing
 *      "don't downgrade if another active subscription exists" logic
 *      that today is duplicated across 3 call sites.
 *   3. resolveEntitlement(state, now) — the only place wall-clock time
 *      enters: a stream can be event-wise "active" but past its
 *      expiresAt, which is a time-based fact, not an event.
 */
import { describe, it, expect } from "vitest";
import {
  foldStream,
  combineStreams,
  resolveEntitlement,
  PLAN_RANK,
  type EntitlementEvent,
} from "../entitlement-reducer";
import { PLAN_ORDER } from "@ai-company-os/core";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-02T00:00:00Z");
const T2 = new Date("2026-02-01T00:00:00Z");
const T3 = new Date("2026-02-02T00:00:00Z");

function ev(partial: Partial<EntitlementEvent> & Pick<EntitlementEvent, "id" | "type" | "sourceTimestamp">): EntitlementEvent {
  return {
    source: "stripe",
    streamId: "stream-1",
    planTier: null,
    expiresAt: null,
    autoRenew: true,
    ...partial,
  };
}

describe("foldStream — single-stream lifecycle", () => {
  it("purchase alone → active, plan granted", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1, autoRenew: true }),
    ]);
    expect(state).toMatchObject({ status: "active", planTier: "CREATOR", expiresAt: T1, autoRenew: true });
  });

  it("purchase → renewal extends expiresAt and can change plan tier (upgrade mid-cycle)", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1 }),
      ev({ id: "e2", type: "renewal", sourceTimestamp: T2, planTier: "BUSINESS", expiresAt: T3 }),
    ]);
    expect(state).toMatchObject({ status: "active", planTier: "BUSINESS", expiresAt: T3 });
  });

  it("cancel sets autoRenew=false but the plan stays active until expiry (not an immediate downgrade)", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T3 }),
      ev({ id: "e2", type: "cancel", sourceTimestamp: T1, autoRenew: false }),
    ]);
    expect(state).toMatchObject({ status: "active", planTier: "CREATOR", expiresAt: T3, autoRenew: false });
  });

  it("grace sets status=in_grace_period without losing the plan tier (still provisionally entitled)", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T3 }),
      ev({ id: "e2", type: "grace", sourceTimestamp: T1 }),
    ]);
    expect(state).toMatchObject({ status: "in_grace_period", planTier: "CREATOR" });
  });

  it("grace → renewal (payment recovered) returns to active", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1 }),
      ev({ id: "e2", type: "grace", sourceTimestamp: T1 }),
      ev({ id: "e3", type: "renewal", sourceTimestamp: T2, planTier: "CREATOR", expiresAt: T3 }),
    ]);
    expect(state).toMatchObject({ status: "active", planTier: "CREATOR", expiresAt: T3 });
  });

  it("refund revokes entitlement IMMEDIATELY — planTier cleared, not just autoRenew", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T3 }),
      ev({ id: "e2", type: "refund", sourceTimestamp: T1 }),
    ]);
    expect(state).toMatchObject({ status: "refunded", planTier: null });
  });

  it("revoke (fraud/chargeback/Apple-Google revocation) clears entitlement immediately", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "BUSINESS", expiresAt: T3 }),
      ev({ id: "e2", type: "revoke", sourceTimestamp: T1 }),
    ]);
    expect(state).toMatchObject({ status: "revoked", planTier: null });
  });

  it("restore re-establishes entitlement after a revoke/refund/expiry (mobile re-verify)", () => {
    const state = foldStream([
      ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1 }),
      ev({ id: "e2", type: "revoke", sourceTimestamp: T1 }),
      ev({ id: "e3", type: "restore", sourceTimestamp: T2, planTier: "CREATOR", expiresAt: T3, autoRenew: true }),
    ]);
    expect(state).toMatchObject({ status: "active", planTier: "CREATOR", expiresAt: T3, autoRenew: true });
  });

  it("empty event list → no stream (null) — nothing ever happened", () => {
    expect(foldStream([])).toBeNull();
  });
});

describe("foldStream — determinism under reordering and duplication", () => {
  const events = [
    ev({ id: "e1", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1 }),
    ev({ id: "e2", type: "grace", sourceTimestamp: T1 }),
    ev({ id: "e3", type: "renewal", sourceTimestamp: T2, planTier: "CREATOR", expiresAt: T3 }),
  ];

  it("folds to the SAME state regardless of input array order (sorted internally by sourceTimestamp, id)", () => {
    const forward = foldStream(events);
    const reversed = foldStream([...events].reverse());
    const shuffled = foldStream([events[1]!, events[2]!, events[0]!]);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("a duplicated event (same id appears twice) does not change the outcome — folding is idempotent per event", () => {
    const withDuplicate = foldStream([...events, events[0]!]);
    const withoutDuplicate = foldStream(events);
    expect(withDuplicate).toEqual(withoutDuplicate);
  });

  it("an OUT-OF-ORDER late arrival (older sourceTimestamp, received/appended last) does not overwrite newer state — this is the exact gap the current direct-write code has", () => {
    // e2 (grace, T1) arrives in the array AFTER e3 (renewal, T2) — simulating
    // a delayed webhook. The reducer must still resolve by sourceTimestamp,
    // not array position, landing on the T2 renewal's state.
    const lateArrival = foldStream([events[0]!, events[2]!, events[1]!]);
    expect(lateArrival).toMatchObject({ status: "active", planTier: "CREATOR", expiresAt: T3 });
  });

  it("same-timestamp events break ties deterministically via id, not insertion order", () => {
    const a = ev({ id: "a-tie", type: "renewal", sourceTimestamp: T1, planTier: "CREATOR", expiresAt: T2 });
    const b = ev({ id: "b-tie", type: "revoke", sourceTimestamp: T1 });
    const base = ev({ id: "e0", type: "purchase", sourceTimestamp: T0, planTier: "CREATOR", expiresAt: T1 });
    const order1 = foldStream([base, a, b]);
    const order2 = foldStream([base, b, a]);
    expect(order1).toEqual(order2);
  });

  it("events from a DIFFERENT stream are never mixed into this stream's fold (caller's responsibility to pre-filter, but the reducer must not silently accept mismatched streamIds)", () => {
    expect(() =>
      foldStream([
        ev({ id: "e1", type: "purchase", sourceTimestamp: T0, streamId: "stream-1", planTier: "CREATOR", expiresAt: T1 }),
        ev({ id: "e2", type: "renewal", sourceTimestamp: T1, streamId: "stream-2", planTier: "CREATOR", expiresAt: T2 }),
      ]),
    ).toThrow(/streamId/i);
  });
});

describe("combineStreams — multi-source tenant entitlement (the 'don't downgrade' rule, generalized)", () => {
  it("a single active stream wins outright", () => {
    const best = combineStreams(
      [{ streamId: "s1", source: "stripe", status: "active", planTier: "CREATOR", expiresAt: T3, autoRenew: true }],
      T1,
    );
    expect(best?.planTier).toBe("CREATOR");
  });

  it("no active streams (all expired/revoked/refunded) → null, nothing to combine", () => {
    const best = combineStreams(
      [{ streamId: "s1", source: "stripe", status: "revoked", planTier: null, expiresAt: null, autoRenew: false }],
      T1,
    );
    expect(best).toBeNull();
  });

  it("Stripe web sub cancels but a mobile IAP sub is still active on a HIGHER tier → mobile wins (never silently downgrades)", () => {
    const best = combineStreams(
      [
        { streamId: "stripe-1", source: "stripe", status: "revoked", planTier: null, expiresAt: null, autoRenew: false },
        { streamId: "apple-1", source: "apple", status: "active", planTier: "BUSINESS", expiresAt: T3, autoRenew: true },
      ],
      T1,
    );
    expect(best).toMatchObject({ source: "apple", planTier: "BUSINESS" });
  });

  it("two active streams on DIFFERENT tiers → the higher tier wins, regardless of array order", () => {
    const streams = [
      { streamId: "s1", source: "stripe" as const, status: "active" as const, planTier: "CREATOR", expiresAt: T3, autoRenew: true },
      { streamId: "s2", source: "google" as const, status: "active" as const, planTier: "BUSINESS", expiresAt: T3, autoRenew: true },
    ];
    expect(combineStreams(streams, T1)?.planTier).toBe("BUSINESS");
    expect(combineStreams([...streams].reverse(), T1)?.planTier).toBe("BUSINESS");
  });

  it("in_grace_period counts as provisionally active (still entitled, still beats an expired/revoked stream)", () => {
    const best = combineStreams(
      [
        { streamId: "s1", source: "stripe", status: "in_grace_period", planTier: "CREATOR", expiresAt: T3, autoRenew: true },
        { streamId: "s2", source: "apple", status: "revoked", planTier: null, expiresAt: null, autoRenew: false },
      ],
      T1,
    );
    expect(best?.planTier).toBe("CREATOR");
  });

  it("R2 regression: a stale event-wise-'active' HIGH-tier stream past its own expiresAt must NOT shadow a genuinely-active LOWER-tier stream during selection", () => {
    const best = combineStreams(
      [
        // BUSINESS's own expiry notification was lost/delayed — still "active" in our records, but its time has passed.
        { streamId: "stripe-1", source: "stripe", status: "active", planTier: "BUSINESS", expiresAt: T1, autoRenew: true },
        { streamId: "apple-1", source: "apple", status: "active", planTier: "CREATOR", expiresAt: T3, autoRenew: true },
      ],
      T2, // after the Stripe stream's expiresAt (T1), before Apple's (T3)
    );
    expect(best).toMatchObject({ source: "apple", planTier: "CREATOR" });
  });

  it("R2 regression: in_grace_period is picked/ranked WITHOUT a wall-clock check, even past what would-be its own expiresAt — grace is event-driven, not time-driven", () => {
    const best = combineStreams(
      [{ streamId: "s1", source: "stripe", status: "in_grace_period", planTier: "PRO", expiresAt: T0, autoRenew: false }],
      T3, // long after T0 — would fail an active-style check, must not matter for grace
    );
    expect(best?.planTier).toBe("PRO");
  });

  it("PLAN_RANK covers every tier the catalog defines, in ascending order — a regression guard so a newly-added plan doesn't silently rank as 0/undefined", () => {
    expect(PLAN_RANK.FREE).toBeLessThan(PLAN_RANK.CREATOR);
    expect(PLAN_RANK.CREATOR).toBeLessThan(PLAN_RANK.PRO);
    expect(PLAN_RANK.PRO).toBeLessThan(PLAN_RANK.BUSINESS);
    expect(PLAN_RANK.BUSINESS).toBeLessThan(PLAN_RANK.ENTERPRISE);
  });

  it("R2 finding #9: PLAN_RANK's tier SET and ORDER actually match @ai-company-os/core's PLAN_ORDER — not just internally self-consistent", () => {
    expect(Object.keys(PLAN_RANK).sort()).toEqual([...PLAN_ORDER].sort());
    PLAN_ORDER.forEach((tier, i) => {
      expect(PLAN_RANK[tier]).toBe(i);
    });
  });
});

describe("resolveEntitlement — the only place wall-clock time enters", () => {
  it("an event-active stream whose expiresAt is in the future → still entitled", () => {
    const plan = resolveEntitlement(
      { streamId: "s1", source: "stripe", status: "active", planTier: "CREATOR", expiresAt: T3, autoRenew: true },
      T1, // now, before expiry
    );
    expect(plan).toBe("CREATOR");
  });

  it("an event-active stream whose expiresAt has already passed → FREE, even though no 'expiry event' ever fired", () => {
    const plan = resolveEntitlement(
      { streamId: "s1", source: "stripe", status: "active", planTier: "CREATOR", expiresAt: T1, autoRenew: false },
      T3, // now, after expiry — nothing ever told us explicitly, time did
    );
    expect(plan).toBe("FREE");
  });

  it("null stream (nothing ever purchased, or nothing currently active) → FREE", () => {
    expect(resolveEntitlement(null, T1)).toBe("FREE");
  });

  it("in_grace_period is entitled, unconditionally on wall-clock time (unlike active) — event-driven, not time-driven", () => {
    const plan = resolveEntitlement(
      { streamId: "s1", source: "stripe", status: "in_grace_period", planTier: "CREATOR", expiresAt: T3, autoRenew: true },
      T1,
    );
    expect(plan).toBe("CREATOR");
  });

  it("R2 regression (finding #1): in_grace_period stays entitled even PAST what would-be its own expiresAt — Stripe past_due carries no reliable grace-deadline field, so grace must not be wall-clock-gated the way active is", () => {
    const plan = resolveEntitlement(
      { streamId: "s1", source: "stripe", status: "in_grace_period", planTier: "PRO", expiresAt: T0, autoRenew: false },
      T3, // long after T0 — would be FREE for an "active" stream, must stay PRO for grace
    );
    expect(plan).toBe("PRO");
  });
});
