import { describe, it, expect, vi, beforeEach } from "vitest";

// cost-guard imports lib/redis at module scope — stub it so no real ioredis
// client is constructed; every test injects its own fake via deps.
vi.mock("../../../lib/redis", () => ({ redis: {} }));

import {
  preflight,
  recordSpend,
  RUN_CAP_USD,
  DAILY_HARD_USD,
  FREEZE_KEY,
  type CostRedis,
} from "../cost-guard";

/** Map-backed CostRedis fake. */
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const api: CostRedis & { store: Map<string, string> } = {
    store,
    async incrbyfloat(key, amount) {
      const next = parseFloat(store.get(key) ?? "0") + amount;
      store.set(key, String(next));
      return String(next);
    },
    async get(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async expire() {},
  };
  return api;
}

const T0 = Date.parse("2026-07-26T12:00:00Z");
const DAY = "2026-07-26";

describe("cost guard preflight", () => {
  let r: ReturnType<typeof fakeRedis>;
  beforeEach(() => {
    r = fakeRedis();
  });

  it("passes a normal estimate", async () => {
    const res = await preflight(0.1, { redis: r, now: () => T0 });
    expect(res).toEqual({ ok: true, softAlert: false });
  });

  it("fails closed on an invalid estimate", async () => {
    expect((await preflight(NaN, { redis: r, now: () => T0 })).ok).toBe(false);
    expect((await preflight(-1, { redis: r, now: () => T0 })).ok).toBe(false);
  });

  it("blocks when the global freeze flag is set (founder-only reset)", async () => {
    r.store.set(FREEZE_KEY, "2026-07-26T11:59:00Z");
    const res = await preflight(0.01, { redis: r, now: () => T0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("FROZEN");
  });

  it("enforces the per-run cap", async () => {
    const res = await preflight(RUN_CAP_USD + 0.01, { redis: r, now: () => T0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("run cap");
  });

  it("enforces the daily hard cap against spend already recorded", async () => {
    r.store.set(`holding:cost:day:${DAY}`, String(DAILY_HARD_USD - 0.5));
    const res = await preflight(1, { redis: r, now: () => T0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("hard cap");
  });

  it("raises the soft alert without blocking", async () => {
    r.store.set(`holding:cost:day:${DAY}`, "9.5");
    const res = await preflight(1, { redis: r, now: () => T0 });
    expect(res.ok).toBe(true);
    expect(res.softAlert).toBe(true);
  });
});

describe("spend-rate sensor", () => {
  it("freezes spend and fires the alarm on >$2 in a 5-minute window", async () => {
    const r = fakeRedis();
    const onRateAlarm = vi.fn(async () => {});
    await recordSpend(1.5, { redis: r, now: () => T0, onRateAlarm });
    expect(r.store.has(FREEZE_KEY)).toBe(false);
    await recordSpend(0.6, { redis: r, now: () => T0 + 60_000, onRateAlarm });
    // 2.1 USD in the same 5-min bucket → freeze FIRST, then alarm.
    expect(r.store.has(FREEZE_KEY)).toBe(true);
    expect(onRateAlarm).toHaveBeenCalledOnce();
    // A later preflight is now blocked.
    const res = await preflight(0.01, { redis: r, now: () => T0 + 61_000 });
    expect(res.ok).toBe(false);
  });

  it("keeps the freeze even when the alarm hook throws", async () => {
    const r = fakeRedis();
    await recordSpend(2.5, {
      redis: r,
      now: () => T0,
      onRateAlarm: async () => {
        throw new Error("telegram down");
      },
    });
    expect(r.store.has(FREEZE_KEY)).toBe(true);
  });

  it("ignores non-positive/invalid amounts", async () => {
    const r = fakeRedis();
    await recordSpend(0, { redis: r, now: () => T0 });
    await recordSpend(NaN, { redis: r, now: () => T0 });
    expect(r.store.size).toBe(0);
  });
});
