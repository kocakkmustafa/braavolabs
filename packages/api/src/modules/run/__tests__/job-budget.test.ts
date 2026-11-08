/**
 * BRA-P0-08 — job budget: pure evaluation + the governance enforcement point
 * (checkJobBudget, the first check of runGovernanceChecks). Persistence and
 * clock are synthetic. NOT covered: a real runner loop over a real database
 * (needs Postgres/Redis; CI "Boot Smoke"/E2E do not exercise budgets yet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/db", () => ({ prisma: {} }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));

import {
  JOB_BUDGET_WARN_RATIO,
  checkJobScope,
  evaluateJobBudget,
  parseJobBudget,
  sumStepTokens,
  type JobUsage,
} from "../job-budget";
import { checkJobBudget } from "../../governance/engine";

const zero: JobUsage = { usd: 0, tokens: 0, steps: 0, elapsedMs: 0, retries: 0 };

describe("parseJobBudget", () => {
  it("null/undefined → no budget (legacy)", () => {
    expect(parseJobBudget(null)).toEqual({ ok: true, budget: null });
    expect(parseJobBudget(undefined)).toEqual({ ok: true, budget: null });
  });
  it("defaults warnRatio to 0.8 = the CLI WARN_AT", () => {
    const r = parseJobBudget({ maxUsd: 5 });
    expect(r.ok && r.budget?.warnRatio).toBe(JOB_BUDGET_WARN_RATIO);
    expect(JOB_BUDGET_WARN_RATIO).toBe(0.8);
  });
  it.each([
    ["string", "oops"],
    ["array", []],
    ["negative usd", { maxUsd: -1 }],
    ["fractional steps", { maxSteps: 1.5 }],
    ["NaN", { maxUsd: Number.NaN }],
    ["unknown key (strict)", { maxUsd: 1, limitless: true }],
    ["warnRatio 1", { warnRatio: 1 }],
    ["warnRatio 0", { warnRatio: 0 }],
  ])("malformed (%s) → invalid, never silently unbounded", (_n, raw) => {
    expect(parseJobBudget(raw).ok).toBe(false);
  });
});

describe("evaluateJobBudget", () => {
  it("under every limit → ok", () => {
    const v = evaluateJobBudget(parseOk({ maxUsd: 10, maxTokens: 1000, maxSteps: 10, timeoutMs: 1000, maxRetries: 2 }), {
      usd: 1, tokens: 100, steps: 1, elapsedMs: 100, retries: 0,
    });
    expect(v.action).toBe("ok");
    expect(v.reason).toBeNull();
  });
  it("warns at 80% (same as the CLI), stops at 100%", () => {
    const b = parseOk({ maxUsd: 10 });
    expect(evaluateJobBudget(b, { ...zero, usd: 7.99 }).action).toBe("ok");
    expect(evaluateJobBudget(b, { ...zero, usd: 8 }).action).toBe("warn");
    expect(evaluateJobBudget(b, { ...zero, usd: 9.99 }).action).toBe("warn");
    const stop = evaluateJobBudget(b, { ...zero, usd: 10 });
    expect(stop.action).toBe("stop");
    expect(stop.stopped).toEqual(["usd"]);
    expect(stop.reason).toMatch(/usd: 10 of 10/);
  });
  it.each([
    ["usd", { maxUsd: 1 }, { usd: 1 }],
    ["tokens", { maxTokens: 100 }, { tokens: 100 }],
    ["steps", { maxSteps: 3 }, { steps: 3 }],
    ["time", { timeoutMs: 5000 }, { elapsedMs: 5000 }],
  ] as const)("%s limit reached → stop", (dim, budget, usage) => {
    const v = evaluateJobBudget(parseOk(budget), { ...zero, ...usage });
    expect(v.action).toBe("stop");
    expect(v.stopped).toEqual([dim]);
  });
  it("strict (final check): reaching the limit is fine, only an overshoot stops", () => {
    const b = parseOk({ maxUsd: 10, maxTokens: 100 });
    expect(evaluateJobBudget(b, { ...zero, usd: 10, tokens: 100 }, { strict: true }).action).toBe("warn");
    const v = evaluateJobBudget(b, { ...zero, usd: 10.01, tokens: 100 }, { strict: true });
    expect(v.action).toBe("stop");
    expect(v.stopped).toEqual(["usd"]);
  });
  it("a limit of 0 is already used up (CLI parity) — no infinite loop on a zero budget", () => {
    expect(evaluateJobBudget(parseOk({ maxSteps: 0 }), zero).action).toBe("stop");
    expect(evaluateJobBudget(parseOk({ maxUsd: 0 }), zero).action).toBe("stop");
  });
  it("retries are an allowance: stop only when EXCEEDED", () => {
    const b = parseOk({ maxRetries: 2 });
    expect(evaluateJobBudget(b, { ...zero, retries: 2 }).action).toBe("warn");
    expect(evaluateJobBudget(b, { ...zero, retries: 3 }).action).toBe("stop");
    // zero allowance with nothing used is neither a warning nor a stop
    expect(evaluateJobBudget(parseOk({ maxRetries: 0 }), zero).action).toBe("ok");
    expect(evaluateJobBudget(parseOk({ maxRetries: 0 }), { ...zero, retries: 1 }).action).toBe("stop");
  });
  it("omitted dimensions are unlimited; several stops are all reported", () => {
    const v = evaluateJobBudget(parseOk({ maxUsd: 1, maxSteps: 1 }), { ...zero, usd: 9, steps: 9, tokens: 1e9, elapsedMs: 1e9 });
    expect(v.stopped).toEqual(["usd", "steps"]);
  });
});

describe("checkJobScope (tenant/workspace gate)", () => {
  const owner = { ownerTenantId: "t1", ownerWorkspaceId: "w1" };
  it("NULL denormalised owner (pre-backfill) → no opinion", () => {
    expect(checkJobScope({ runTenantId: null, runWorkspaceId: undefined, ...owner })).toEqual({ ok: true });
  });
  it("matching owner → ok", () => {
    expect(checkJobScope({ runTenantId: "t1", runWorkspaceId: "w1", ...owner })).toEqual({ ok: true });
  });
  it("different tenant or workspace → hard fail", () => {
    expect(checkJobScope({ runTenantId: "t2", runWorkspaceId: "w1", ...owner }).ok).toBe(false);
    expect(checkJobScope({ runTenantId: "t1", runWorkspaceId: "w9", ...owner }).ok).toBe(false);
  });
});

describe("sumStepTokens", () => {
  it("sums prompt + completion; NULL counts as 0 (unmetered, never guessed)", () => {
    expect(sumStepTokens([{ promptTokens: 10, completionTokens: 5 }, { promptTokens: null, completionTokens: null }, {}])).toBe(15);
  });
});

describe("governance enforcement point — checkJobBudget", () => {
  const NOW = new Date("2026-11-08T12:00:00Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const ctx = (run: Record<string, unknown>, currentCost = 0) =>
    ({ run, currentCost, tenantId: "t1", companyId: "w1", config: {} as never });

  it("no jobBudget → allowed (legacy runs unchanged)", () => {
    expect(checkJobBudget(ctx({ jobBudget: null, steps: [] }, 9999))).toEqual({ allowed: true });
  });
  it("USD ceiling stops the run with a hard_stop and a readable reason", () => {
    const r = checkJobBudget(ctx({ jobBudget: { maxUsd: 2 }, steps: [] }, 2.5));
    expect(r.allowed).toBe(false);
    expect(r.stopType).toBe("hard_stop");
    expect(r.reason).toMatch(/Job budget exhausted \(usd/);
    expect(r.details).toMatchObject({ jobBudget: "exhausted", stopped: ["usd"] });
  });
  it("token ceiling counts step tokens", () => {
    const steps = [{ status: "COMPLETED", promptTokens: 600, completionTokens: 500 }];
    expect(checkJobBudget(ctx({ jobBudget: { maxTokens: 1000 }, steps })).allowed).toBe(false);
    expect(checkJobBudget(ctx({ jobBudget: { maxTokens: 2000 }, steps })).allowed).toBe(true);
  });
  it("step ceiling counts COMPLETED steps only → loops cannot run forever", () => {
    const steps = [{ status: "COMPLETED" }, { status: "COMPLETED" }, { status: "RUNNING" }];
    expect(checkJobBudget(ctx({ jobBudget: { maxSteps: 2 }, steps })).allowed).toBe(false);
    expect(checkJobBudget(ctx({ jobBudget: { maxSteps: 3 }, steps })).allowed).toBe(true);
  });
  it("timeout is measured from startedAt; never-started run has 0 elapsed", () => {
    const startedAt = new Date(NOW.getTime() - 61_000);
    expect(checkJobBudget(ctx({ jobBudget: { timeoutMs: 60_000 }, startedAt, steps: [] })).allowed).toBe(false);
    expect(checkJobBudget(ctx({ jobBudget: { timeoutMs: 60_000 }, startedAt: null, steps: [] })).allowed).toBe(true);
  });
  it("retry cap uses runs.retry_count", () => {
    expect(checkJobBudget(ctx({ jobBudget: { maxRetries: 1 }, retryCount: 2, steps: [] })).allowed).toBe(false);
    expect(checkJobBudget(ctx({ jobBudget: { maxRetries: 1 }, retryCount: 1, steps: [] })).allowed).toBe(true);
  });
  it("malformed stored budget → stop (fail-closed), not unbounded", () => {
    const r = checkJobBudget(ctx({ jobBudget: { maxUsd: "lots" }, steps: [] }));
    expect(r.allowed).toBe(false);
    expect(r.details).toMatchObject({ jobBudget: "invalid" });
  });
  it("scope mismatch stops even with no budget", () => {
    const r = checkJobBudget(ctx({ jobBudget: null, tenantId: "other-tenant", steps: [] }));
    expect(r.allowed).toBe(false);
    expect(r.details).toMatchObject({ jobBudget: "scope" });
    expect(checkJobBudget(ctx({ jobBudget: null, workspaceId: "other-ws", steps: [] })).allowed).toBe(false);
  });
});

function parseOk(raw: unknown) {
  const r = parseJobBudget(raw);
  if (!r.ok || !r.budget) throw new Error("test budget invalid");
  return r.budget;
}
