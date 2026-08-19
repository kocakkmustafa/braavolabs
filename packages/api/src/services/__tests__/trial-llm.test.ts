/**
 * Trial LLM gate unit tests — B1(2): the D-009-corrected trial-credit
 * mechanism must be FAIL-CLOSED once a tenant's counter is exhausted.
 *
 * tryConsumeTrialRun() is the gate: it must return a usable config ONLY
 * while remaining = trialRunsLimit - trialRunsUsed > 0, and null
 * (never a system-key fallback, never negative credit) once remaining
 * hits 0. commitTrialRun() is the mutation that walks the counter down
 * — checked here for the increment contract; the "does an exhausted
 * counter still serve" boundary is the security-relevant assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envMock = vi.hoisted(() => ({
  GROQ_TRIAL_MODEL: undefined as string | undefined,
}));
vi.mock("../../config/env", () => ({ env: envMock }));

const db = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  userFindFirst: vi.fn(),
}));
vi.mock("../../lib/db", () => ({
  prisma: {
    tenant: {
      findUnique: (...a: unknown[]) => db.tenantFindUnique(...a),
      update: (...a: unknown[]) => db.tenantUpdate(...a),
    },
    user: {
      findFirst: (...a: unknown[]) => db.userFindFirst(...a),
    },
  },
}));

// The $0.30-total hosted-trial cost cap is the SAME bucket trial-credit
// .service.ts already guards (atomic reserve/settle, Opus-hardened) — this
// module settles read-only checks + real cost into it, never re-implements
// the guard itself.
const creditGate = vi.hoisted(() => ({
  trialCreditEnabled: vi.fn(),
  getForgeTrialCreditStatus: vi.fn(),
  settleTrialCredit: vi.fn(),
}));
vi.mock("../../modules/billing/trial-credit.service", () => creditGate);

import {
  tryConsumeTrialRun,
  commitTrialRun,
  getTrialStatus,
  trialEnabled,
} from "../trial-llm";

const TENANT = "tenant-trial";

function seedTenant(overrides: {
  plan?: string;
  trialRunsUsed?: number;
  trialRunsLimit?: number;
} = {}) {
  db.tenantFindUnique.mockResolvedValue({
    plan: overrides.plan ?? "FREE",
    trialRunsUsed: overrides.trialRunsUsed ?? 0,
    trialRunsLimit: overrides.trialRunsLimit ?? 3,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GROQ_API_KEY = "gsk_trial_key";
  envMock.GROQ_TRIAL_MODEL = undefined;
  db.tenantUpdate.mockResolvedValue({});
  // Default: tenant has a verified-email user — existing tests exercise the
  // credit/plan/dormant boundaries and shouldn't also have to know about the
  // separate email-verification gate. Tests for THAT gate override this.
  db.userFindFirst.mockResolvedValue({ id: "user-verified" });
  // Default: cost cap disabled (mirrors prod's FORGE_TRIAL_CREDIT_USD_CAP=0
  // default) — existing tests shouldn't need to know about the cap either.
  // Tests for the cap gate override this.
  creditGate.trialCreditEnabled.mockReturnValue(false);
  creditGate.getForgeTrialCreditStatus.mockResolvedValue({
    enabled: false,
    capUsd: 0,
    spentUsd: 0,
    remainingUsd: 0,
    exhausted: false,
  });
  creditGate.settleTrialCredit.mockResolvedValue(undefined);
});

describe("trialEnabled", () => {
  it("false when GROQ_API_KEY is unset — trial system dormant", () => {
    delete process.env.GROQ_API_KEY;
    expect(trialEnabled()).toBe(false);
  });

  it("true when GROQ_API_KEY is set", () => {
    process.env.GROQ_API_KEY = "gsk_x";
    expect(trialEnabled()).toBe(true);
  });
});

describe("tryConsumeTrialRun — fail-closed boundary", () => {
  it("remaining=1 (exact boundary, last credit) → serves a config", async () => {
    seedTenant({ trialRunsUsed: 2, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).not.toBeNull();
    expect(decision!.remainingBefore).toBe(1);
    expect(decision!.remainingAfter).toBe(0);
    expect(decision!.config.provider).toBe("GROQ");
  });

  it("remaining=0 (used === limit) → null, no config ever returned", async () => {
    seedTenant({ trialRunsUsed: 3, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("aşımda — trialRunsUsed > trialRunsLimit (already over, e.g. a past race) → still null, never negative credit", async () => {
    seedTenant({ trialRunsUsed: 5, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("trial system dormant (no GROQ key) → null regardless of remaining credit", async () => {
    delete process.env.GROQ_API_KEY;
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
    // Fail-closed even before hitting the DB — dormant gate short-circuits.
    expect(db.tenantFindUnique).not.toHaveBeenCalled();
  });

  it("PAID plan tenants never route through the trial pool, even with credit left", async () => {
    seedTenant({ plan: "CREATOR", trialRunsUsed: 0, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("unknown tenant (deleted / bad id) → null, fail-closed rather than throw", async () => {
    db.tenantFindUnique.mockResolvedValue(null);
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("does NOT mutate the counter itself — pure read, commitTrialRun owns the write", async () => {
    seedTenant({ trialRunsUsed: 1, trialRunsLimit: 3 });
    await tryConsumeTrialRun(TENANT);
    expect(db.tenantUpdate).not.toHaveBeenCalled();
  });

  it("concurrent calls before either commits both see the same remaining slot (documented ±1 race, never unbounded)", async () => {
    seedTenant({ trialRunsUsed: 2, trialRunsLimit: 3 });
    const [a, b] = await Promise.all([
      tryConsumeTrialRun(TENANT),
      tryConsumeTrialRun(TENANT),
    ]);
    // Both see remaining=1 pre-commit (worst case: one extra run served,
    // never an unbounded/negative credit condition).
    expect(a?.remainingBefore).toBe(1);
    expect(b?.remainingBefore).toBe(1);
  });
});

describe("tryConsumeTrialRun — verified-email abuse guard", () => {
  it("no verified-email user on the tenant → null, even with full credit and FREE plan", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    db.userFindFirst.mockResolvedValue(null);
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("queries for a user on THIS tenant with a non-null emailVerifiedAt", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    await tryConsumeTrialRun(TENANT);
    expect(db.userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, emailVerifiedAt: { not: null } }),
      }),
    );
  });

  it("does not even check email verification once credit is already exhausted (cheap check first)", async () => {
    seedTenant({ trialRunsUsed: 3, trialRunsLimit: 3 });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
    expect(db.userFindFirst).not.toHaveBeenCalled();
  });

  it("a verified-email user unblocks the trial exactly as before this gate existed", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    db.userFindFirst.mockResolvedValue({ id: "user-verified" });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).not.toBeNull();
    expect(decision!.config.provider).toBe("GROQ");
  });
});

describe("tryConsumeTrialRun — $0.30 hosted-trial cost cap (shared with trial-credit.service.ts)", () => {
  it("cap disabled (prod default) — never even reads credit status", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    creditGate.trialCreditEnabled.mockReturnValue(false);
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).not.toBeNull();
    expect(creditGate.getForgeTrialCreditStatus).not.toHaveBeenCalled();
  });

  it("cap enabled and exhausted — null, even with full run-count credit and a verified user", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    creditGate.trialCreditEnabled.mockReturnValue(true);
    creditGate.getForgeTrialCreditStatus.mockResolvedValue({
      enabled: true, capUsd: 0.3, spentUsd: 0.3, remainingUsd: 0, exhausted: true,
    });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
  });

  it("cap enabled but not yet exhausted — serves normally", async () => {
    seedTenant({ trialRunsUsed: 0, trialRunsLimit: 3 });
    creditGate.trialCreditEnabled.mockReturnValue(true);
    creditGate.getForgeTrialCreditStatus.mockResolvedValue({
      enabled: true, capUsd: 0.3, spentUsd: 0.1, remainingUsd: 0.2, exhausted: false,
    });
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).not.toBeNull();
  });

  it("checks the cost cap AFTER the cheaper run-count/email checks, not before", async () => {
    seedTenant({ trialRunsUsed: 3, trialRunsLimit: 3 }); // exhausted count
    creditGate.trialCreditEnabled.mockReturnValue(true);
    const decision = await tryConsumeTrialRun(TENANT);
    expect(decision).toBeNull();
    expect(creditGate.getForgeTrialCreditStatus).not.toHaveBeenCalled();
  });
});

describe("commitTrialRun", () => {
  it("increments trialRunsUsed by exactly 1", async () => {
    await commitTrialRun(TENANT);
    expect(db.tenantUpdate).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { trialRunsUsed: { increment: 1 } },
    });
  });

  it("no costUsd argument — never touches the cost-cap bucket (count-only callers unaffected)", async () => {
    await commitTrialRun(TENANT);
    expect(creditGate.settleTrialCredit).not.toHaveBeenCalled();
  });

  it("cap disabled — a costUsd argument is still a no-op on the bucket (matches prod default)", async () => {
    creditGate.trialCreditEnabled.mockReturnValue(false);
    await commitTrialRun(TENANT, 0.0015);
    expect(creditGate.settleTrialCredit).not.toHaveBeenCalled();
  });

  it("cap enabled + costUsd given — settles the REAL cost into the shared bucket with a zero reservation (nothing was reserved upfront)", async () => {
    creditGate.trialCreditEnabled.mockReturnValue(true);
    await commitTrialRun(TENANT, 0.0015);
    expect(creditGate.settleTrialCredit).toHaveBeenCalledWith(TENANT, 0, 0.0015);
  });

  it("the counter increment still happens even if settling the cost bucket throws (counter is the run-count source of truth)", async () => {
    creditGate.trialCreditEnabled.mockReturnValue(true);
    creditGate.settleTrialCredit.mockRejectedValue(new Error("db blip"));
    await expect(commitTrialRun(TENANT, 0.0015)).resolves.not.toThrow();
    expect(db.tenantUpdate).toHaveBeenCalled();
  });
});

describe("getTrialStatus", () => {
  it("exhausted=true exactly at remaining=0, never negative remaining", async () => {
    seedTenant({ trialRunsUsed: 3, trialRunsLimit: 3 });
    const status = await getTrialStatus(TENANT);
    expect(status).toMatchObject({ used: 3, limit: 3, remaining: 0, exhausted: true });
  });

  it("clamps remaining to 0 when used has overshot limit (defensive floor)", async () => {
    seedTenant({ trialRunsUsed: 7, trialRunsLimit: 3 });
    const status = await getTrialStatus(TENANT);
    expect(status.remaining).toBe(0);
    expect(status.exhausted).toBe(true);
  });

  it("PAID plan reports enabled=false, exhausted=false — trial is irrelevant, not a wall", async () => {
    seedTenant({ plan: "PRO", trialRunsUsed: 3, trialRunsLimit: 3 });
    const status = await getTrialStatus(TENANT);
    expect(status).toMatchObject({ enabled: false, exhausted: false });
  });
});
