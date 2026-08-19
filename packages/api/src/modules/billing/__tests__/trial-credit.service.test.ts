/**
 * Forge trial-credit gate (FAZ1-1C) — the security-relevant assertions are
 * the fail-closed boundary (cap=0 rejects everything, cap>0 stops exactly
 * at the ceiling) and the atomicity of the reservation guard (a burst of
 * concurrent reservations can never jointly exceed the cap). Mirrors the
 * mocking style of modules/billing/__tests__/metering.test.ts (tenantTx /
 * $queryRaw / $executeRaw) and the reserve-then-commit-or-refund assertions
 * of services/__tests__/trial-llm.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envMock = vi.hoisted(() => ({
  FORGE_TRIAL_CREDIT_USD_CAP: 0,
  CEREBRAS_API_KEY: undefined as string | undefined,
  GROQ_API_KEY: undefined as string | undefined,
  ZHIPU_API_KEY: undefined as string | undefined,
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

const db = vi.hoisted(() => ({
  usageMeterFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    usageMeter: { findUnique: (...a: unknown[]) => db.usageMeterFindUnique(...a) },
  },
  // RLS-real: raw quota queries run through tenantTx (same shape as
  // metering.test.ts's mock — fn is invoked against a tx exposing the raw
  // delegates).
  tenantTx: (fn: any) =>
    fn({
      $queryRaw: (...a: unknown[]) => db.queryRaw(...a),
      $executeRaw: (...a: unknown[]) => db.executeRaw(...a),
    }),
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return { ...actual, chatCompletion: (...a: unknown[]) => chatCompletionMock(...a) };
});

import {
  reserveTrialCredit,
  settleTrialCredit,
  refundTrialCredit,
  getForgeTrialCreditStatus,
  trialCreditEnabled,
  hasSystemHeldKey,
  runForgeTrialCompletion,
  TrialCreditExhaustedError,
  NoSystemHeldKeyError,
  TRIAL_CALL_RESERVATION_USD,
} from "../trial-credit.service";
import { logger } from "../../../lib/logger";

const TENANT = "tenant-forge-trial";
const MICRO = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0;
  envMock.CEREBRAS_API_KEY = undefined;
  envMock.GROQ_API_KEY = undefined;
  envMock.ZHIPU_API_KEY = undefined;
});

describe("trialCreditEnabled / hasSystemHeldKey", () => {
  it("disabled when cap is the default 0", () => {
    expect(trialCreditEnabled()).toBe(false);
  });

  it("enabled once cap is a positive number", () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.5;
    expect(trialCreditEnabled()).toBe(true);
  });

  it("disabled for a negative or NaN cap (defensive fail-closed, even though env.ts already clamps >= 0)", () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = -1;
    expect(trialCreditEnabled()).toBe(false);
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = NaN;
    expect(trialCreditEnabled()).toBe(false);
  });

  it("hasSystemHeldKey reflects env live (not captured at import time)", () => {
    expect(hasSystemHeldKey("CEREBRAS")).toBe(false);
    envMock.CEREBRAS_API_KEY = "csk-test-key";
    expect(hasSystemHeldKey("CEREBRAS")).toBe(true);
    expect(hasSystemHeldKey("GROQ")).toBe(false);
  });

  it("providers outside the Forge trial catalogue (e.g. ANTHROPIC) never report a system-held key here", () => {
    expect(hasSystemHeldKey("ANTHROPIC")).toBe(false);
  });
});

describe("reserveTrialCredit — fail-closed boundary", () => {
  it("cap=0 (default/off) → null, DB never touched", async () => {
    const result = await reserveTrialCredit(TENANT);
    expect(result).toBeNull();
    expect(db.queryRaw).not.toHaveBeenCalled();
  });

  it("cap>0 and the reservation fits → returns a reservation, the SQL guard is the WHERE clause", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1; // 1_000_000 micro-usd
    db.queryRaw.mockResolvedValue([{ value: Math.round(TRIAL_CALL_RESERVATION_USD * MICRO) }]);

    const result = await reserveTrialCredit(TENANT);

    expect(result).toEqual({ reservationUsd: TRIAL_CALL_RESERVATION_USD });
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("a caller-supplied reservationUsd overrides the default ceiling (e.g. trial-llm.ts's larger per-run reservation)", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    const customReservation = 0.1;
    db.queryRaw.mockResolvedValue([{ value: Math.round(customReservation * MICRO) }]);

    const result = await reserveTrialCredit(TENANT, customReservation);

    expect(result).toEqual({ reservationUsd: customReservation });
  });

  it("a caller-supplied reservationUsd larger than the cap is refused fail-closed, same as the default ceiling would be", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.05;
    const result = await reserveTrialCredit(TENANT, 0.1);
    expect(result).toBeNull();
    expect(db.queryRaw).not.toHaveBeenCalled();
  });

  it("cap already reached (existing usage leaves no headroom) → the atomic WHERE fails (empty rows) → null, fail-closed, never throws", async () => {
    // cap (0.03) is deliberately LARGER than the reservation ceiling (0.02)
    // here — this test is specifically about the DB-side WHERE failing
    // because prior usage already ate the headroom, as distinct from the
    // "cap itself is smaller than one reservation" case covered below.
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.03;
    db.queryRaw.mockResolvedValue([]); // WHERE value+reservation<=cap failed on the DB side

    const result = await reserveTrialCredit(TENANT);

    expect(result).toBeNull();
    expect(db.queryRaw).toHaveBeenCalledTimes(1); // the DB path WAS reached this time
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.stringMatching(/cap reached/i),
    );
  });

  it("P2-A2: a cap SMALLER than a single reservation refuses even the tenant's very FIRST trial call — never bypasses via the unconditional INSERT branch", async () => {
    // Before the fix, `INSERT … VALUES (…) ON CONFLICT … WHERE …` only
    // guarded the UPDATE (conflict) branch — a brand new row (no conflict
    // yet) inserted UNCONDITIONALLY, so a cap smaller than the reservation
    // ceiling still let the very first call through. cap=0.01 (10,000
    // micro) < reservation=0.02 (20,000 micro) must now refuse before ever
    // touching the DB.
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.01;

    const result = await reserveTrialCredit(TENANT);

    expect(result).toBeNull();
    expect(db.queryRaw).not.toHaveBeenCalled(); // short-circuited in JS, no wasted round trip
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, capUsd: 0.01 }),
      expect.stringMatching(/smaller than the per-call reservation ceiling/i),
    );
  });

  it("reservation math never allows the bucket to exceed the cap under a concurrent burst (atomic guard)", async () => {
    // cap = 0.03 USD = 30,000 micro-usd; each reservation = 0.02 USD = 20,000
    // micro-usd → at most ONE of a 3-way burst may succeed (2 would be
    // 40,000 > 30,000). The mock below embodies the exact SQL guard
    // (`WHERE usage_meters.value + reservation <= cap`) against a single
    // shared counter, so this proves the ARITHMETIC never overshoots even
    // when three reservations are attempted "simultaneously" via
    // Promise.all (each call's synchronous prefix — everything before its
    // first internal await — runs to completion before the next call
    // starts, exactly mirroring one indivisible SQL statement per call).
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.03;
    let value = 0;
    db.queryRaw.mockImplementation(async (_strings: unknown, ...vals: unknown[]) => {
      const reservationMicros = vals[2] as number;
      const capMicros = vals[vals.length - 1] as number;
      if (value + reservationMicros <= capMicros) {
        value += reservationMicros;
        return [{ value }];
      }
      return [];
    });

    const results = await Promise.all([
      reserveTrialCredit(TENANT),
      reserveTrialCredit(TENANT),
      reserveTrialCredit(TENANT),
    ]);

    const successes = results.filter((r) => r !== null);
    expect(successes.length).toBe(1);
    expect(value).toBe(20_000); // exactly one reservation landed, never exceeds capMicros (30,000)
    expect(value).toBeLessThanOrEqual(30_000);
  });

  it("does NOT mutate anything on the read side — reservation is the only write; a separate settle/refund call owns the true-up", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    db.queryRaw.mockResolvedValue([{ value: 20_000 }]);
    await reserveTrialCredit(TENANT);
    expect(db.executeRaw).not.toHaveBeenCalled();
  });
});

describe("settleTrialCredit / refundTrialCredit", () => {
  it("settles the delta between the real cost and the flat reservation (real cost cheaper → net refund)", async () => {
    db.executeRaw.mockResolvedValue(1);
    await settleTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD, 0.0001); // real cost far under the 0.02 ceiling
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("a no-op delta (actual cost exactly equals the reservation) skips the DB write entirely", async () => {
    await settleTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD, TRIAL_CALL_RESERVATION_USD);
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it("refundTrialCredit gives back the FULL reservation (equivalent to settling at cost=0)", async () => {
    db.executeRaw.mockResolvedValue(1);
    await refundTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("a DB failure during settle is swallowed (non-fatal) — callers (runForgeTrialCompletion) must never see this throw", async () => {
    db.executeRaw.mockRejectedValue(new Error("connection reset"));
    await expect(settleTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD, 0)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.stringMatching(/settleTrialCredit failed/i),
    );
  });

  it("P2-F: a $0 actual cost still retires MIN_TRIAL_UNIT_USD from the bucket via settleTrialCredit — never a full no-op", async () => {
    db.executeRaw.mockResolvedValue(1);
    await settleTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD, 0);

    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    // First interpolation in the UPDATE template is deltaMicros (see the SQL
    // in trial-credit.service.ts). floor(100) − reservation(20,000) = −19,900.
    const deltaMicros = db.executeRaw.mock.calls[0]![1] as number;
    expect(deltaMicros).toBe(100 - Math.round(TRIAL_CALL_RESERVATION_USD * MICRO));
  });

  it("P2-F: NaN / negative / non-finite actual cost collapses to the floor, never to a negative or corrupt delta", async () => {
    db.executeRaw.mockResolvedValue(1);
    for (const badCost of [NaN, -5, Infinity, -Infinity]) {
      db.executeRaw.mockClear();
      await settleTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD, badCost);
      expect(db.executeRaw).toHaveBeenCalledTimes(1);
      const deltaMicros = db.executeRaw.mock.calls[0]![1] as number;
      // Same delta as a real $0 cost (floored) — never NaN, never more
      // negative than the reservation itself (i.e. never "extra credit").
      expect(deltaMicros).toBe(100 - Math.round(TRIAL_CALL_RESERVATION_USD * MICRO));
      expect(Number.isFinite(deltaMicros)).toBe(true);
    }
  });

  it("refundTrialCredit is NEVER floored (distinct from settleTrialCredit) — a failed call gives back the exact full reservation, no floor retained", async () => {
    db.executeRaw.mockResolvedValue(1);
    await refundTrialCredit(TENANT, TRIAL_CALL_RESERVATION_USD);

    const deltaMicros = db.executeRaw.mock.calls[0]![1] as number;
    expect(deltaMicros).toBe(-Math.round(TRIAL_CALL_RESERVATION_USD * MICRO)); // exactly -20,000, no floor subtracted
  });
});

describe("getForgeTrialCreditStatus", () => {
  it("disabled (cap=0) reports a closed, non-exhausted, zeroed status without touching prisma", async () => {
    const status = await getForgeTrialCreditStatus(TENANT);
    expect(status).toEqual({ enabled: false, capUsd: 0, spentUsd: 0, remainingUsd: 0, exhausted: false });
    expect(db.usageMeterFindUnique).not.toHaveBeenCalled();
  });

  it("enabled, no spend yet (no meter row) → remaining equals the full cap", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.5;
    db.usageMeterFindUnique.mockResolvedValue(null);
    const status = await getForgeTrialCreditStatus(TENANT);
    expect(status).toEqual({ enabled: true, capUsd: 0.5, spentUsd: 0, remainingUsd: 0.5, exhausted: false });
  });

  it("enabled, partially spent → remaining is cap minus spend, converted from micro-usd", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.5;
    db.usageMeterFindUnique.mockResolvedValue({ value: 200_000 }); // $0.20 spent
    const status = await getForgeTrialCreditStatus(TENANT);
    expect(status.spentUsd).toBeCloseTo(0.2, 6);
    expect(status.remainingUsd).toBeCloseTo(0.3, 6);
    expect(status.exhausted).toBe(false);
  });

  it("exhausted exactly when spend meets or exceeds the cap, remaining clamped at 0", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.5;
    db.usageMeterFindUnique.mockResolvedValue({ value: 900_000 }); // spent MORE than cap (overshoot from the reservation ceiling true-up)
    const status = await getForgeTrialCreditStatus(TENANT);
    expect(status.remainingUsd).toBe(0);
    expect(status.exhausted).toBe(true);
  });
});

describe("runForgeTrialCompletion — the single wiring point", () => {
  it("throws NoSystemHeldKeyError when Braavolabs holds no key for the provider — never reserves credit", async () => {
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    await expect(
      runForgeTrialCompletion(TENANT, "OPENROUTER", "openai/gpt-4o", "sys", [{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(NoSystemHeldKeyError);
    expect(db.queryRaw).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("throws TrialCreditExhaustedError when the cap is closed (0) — chatCompletion is NEVER dialed (never fail-open)", async () => {
    envMock.CEREBRAS_API_KEY = "csk-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0;

    await expect(
      runForgeTrialCompletion(TENANT, "CEREBRAS", "gpt-oss-120b", "sys", [{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(TrialCreditExhaustedError);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("throws TrialCreditExhaustedError when the cap is reached — chatCompletion is NEVER dialed", async () => {
    envMock.CEREBRAS_API_KEY = "csk-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.03; // > reservation ceiling — this exercises the DB-WHERE-fails path, not the cap-too-small early guard
    db.queryRaw.mockResolvedValue([]); // reservation refused

    await expect(
      runForgeTrialCompletion(TENANT, "CEREBRAS", "gpt-oss-120b", "sys", [{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(TrialCreditExhaustedError);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("success path: reserves, dials the SYSTEM key, settles the REAL cost_usd (computed via priceForModel, not hard-coded 0), returns costUsd", async () => {
    envMock.CEREBRAS_API_KEY = "csk-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    db.queryRaw.mockResolvedValue([{ value: 20_000 }]);
    db.executeRaw.mockResolvedValue(1);
    chatCompletionMock.mockResolvedValue({
      content: "OK",
      inputTokens: 1_000_000, // exactly 1M so gpt-oss-120b's $0.35/M input price gives a clean, non-zero, non-hardcoded number
      outputTokens: 1_000_000, // $0.75/M output
      model: "gpt-oss-120b",
      provider: "CEREBRAS",
    });

    const result = await runForgeTrialCompletion(
      TENANT,
      "CEREBRAS",
      "gpt-oss-120b",
      "You are a connectivity check.",
      [{ role: "user", content: "Reply with exactly: OK" }],
      16,
    );

    // priceForModel("gpt-oss-120b") = { inputPerM: 0.35, outputPerM: 0.75 }
    // cost = 1*0.35 + 1*0.75 = 1.10 — a real computed number, not 0.
    expect(result.costUsd).toBeCloseTo(1.1, 6);
    expect(result.content).toBe("OK");
    // The dialed config used the SYSTEM key, never anything tenant-supplied.
    expect(chatCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "CEREBRAS", apiKey: "csk-live" }),
      expect.any(String),
      expect.any(Array),
      16,
    );
    // Settled (true-up), not just reserved.
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("P2-F: ZHIPU's glm-4.7-flash (a genuinely $0-priced model) still gets BOUNDED by the cap — never unlimited trial calls", async () => {
    // End-to-end through the real reserve→dial→settle pipeline (no shortcut
    // mocking of settleTrialCredit/reserveTrialCredit themselves) — proves
    // the floor closes the "cap is a no-op for $0-priced models" gap for
    // real, not just at the unit level.
    //
    // cap is deliberately set to reservation + 10×floor = 0.02 + 10×0.0001
    // = 0.021 (21,000 micro) so this test lands on a clean, small,
    // documented number of successful calls before refusal — NOT because
    // that specific cap is a recommended production value (a real operator
    // cap will usually be an order of magnitude bigger than a single
    // reservation; this file just needs a tractable number of loop
    // iterations to prove the bound is real and finite).
    envMock.ZHIPU_API_KEY = "zhipu-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 0.021;
    chatCompletionMock.mockResolvedValue({
      content: "OK", inputTokens: 5, outputTokens: 1, model: "glm-4.7-flash", provider: "ZHIPU",
    });

    let value = 0;
    db.queryRaw.mockImplementation(async (_strings: unknown, ...vals: unknown[]) => {
      const reservationMicros = vals[2] as number;
      const capMicros = vals[vals.length - 1] as number;
      if (value + reservationMicros <= capMicros) {
        value += reservationMicros;
        return [{ value }];
      }
      return [];
    });
    db.executeRaw.mockImplementation(async (_strings: unknown, ...vals: unknown[]) => {
      const deltaMicros = vals[0] as number;
      value = Math.max(0, value + deltaMicros);
      return 1;
    });

    let succeeded = 0;
    let terminalError: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        const result = await runForgeTrialCompletion(
          TENANT, "ZHIPU", "glm-4.7-flash", "sys", [{ role: "user", content: "hi" }],
        );
        expect(result.costUsd).toBe(0); // priceForModel("glm-4.7-flash") is genuinely {0,0} — real, not fabricated
        succeeded++;
      } catch (err) {
        terminalError = err;
        break;
      }
    }

    // Bounded, not unlimited: the loop hit a real refusal well before the
    // 50-iteration ceiling, and every successful call actually settled
    // (retiring the floor) rather than silently no-op'ing back to 0.
    expect(terminalError).toBeInstanceOf(TrialCreditExhaustedError);
    expect(succeeded).toBeGreaterThan(0);
    expect(succeeded).toBeLessThan(50);
    expect(db.executeRaw).toHaveBeenCalledTimes(succeeded); // one floor-settle per success
    // Bucket after the last success sits within one reservation ceiling of
    // the cap (can't have more headroom than that, or one more would fit).
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(Math.round(0.021 * MICRO));
  });

  it("failure path: chatCompletion throws → the reservation is refunded in full, the original error propagates", async () => {
    envMock.CEREBRAS_API_KEY = "csk-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    db.queryRaw.mockResolvedValue([{ value: 20_000 }]);
    db.executeRaw.mockResolvedValue(1);
    const upstreamError = new Error("CEREBRAS API error 503: overloaded");
    chatCompletionMock.mockRejectedValue(upstreamError);

    await expect(
      runForgeTrialCompletion(TENANT, "CEREBRAS", "gpt-oss-120b", "sys", [{ role: "user", content: "hi" }]),
    ).rejects.toThrow("overloaded");

    // Refund = settle(reservationUsd, actualCostUsd=0) → a real DB write happened.
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("BYOK path is never affected by the trial-credit gate", () => {
  it("reserveTrialCredit / runForgeTrialCompletion never touch userAIConfig or any BYOK-config table", async () => {
    envMock.CEREBRAS_API_KEY = "csk-live";
    envMock.FORGE_TRIAL_CREDIT_USD_CAP = 1;
    db.queryRaw.mockResolvedValue([{ value: 20_000 }]);
    db.executeRaw.mockResolvedValue(1);
    chatCompletionMock.mockResolvedValue({
      content: "OK", inputTokens: 1, outputTokens: 1, model: "gpt-oss-120b", provider: "CEREBRAS",
    });

    await runForgeTrialCompletion(TENANT, "CEREBRAS", "gpt-oss-120b", "sys", [{ role: "user", content: "hi" }]);

    // The only prisma surface this module touches at all is usageMeter
    // (asserted throughout this file) — there is no userAIConfig mock wired
    // up, so any attempt to read/write it would throw "not a function" and
    // fail the test instead of silently passing.
    expect(db.usageMeterFindUnique).not.toHaveBeenCalled();
  });
});
