/**
 * Resume idempotency (planResume) — pure unit tests.
 *
 * Guards the fix where a run paused on ask_user used to re-execute every
 * already-COMPLETED step on resume (re-spending / re-sending). planResume is
 * the contract the runner uses to SKIP completed steps + SEED their cost.
 */
import { describe, it, expect } from "vitest";
import { planResume } from "../executor";

describe("planResume", () => {
  it("fresh run (no prior completed) → nothing to skip, zero seed", () => {
    const { skip, seededCost } = planResume([]);
    expect(skip.size).toBe(0);
    expect(seededCost).toBe(0);
  });

  it("skips every prior-completed step index", () => {
    const { skip } = planResume([
      { stepIndex: 0, costUsd: 0.01 },
      { stepIndex: 1, costUsd: 0.02 },
    ]);
    expect(skip.has(0)).toBe(true);
    expect(skip.has(1)).toBe(true);
    expect(skip.has(2)).toBe(false); // the paused step re-runs
  });

  it("seeds total cost from completed steps (no double-count on resume)", () => {
    const { seededCost } = planResume([
      { stepIndex: 0, costUsd: 0.0125 },
      { stepIndex: 1, costUsd: 0.0075 },
    ]);
    expect(seededCost).toBeCloseTo(0.02, 6);
  });

  it("treats null/undefined costUsd as 0", () => {
    const { seededCost, skip } = planResume([
      { stepIndex: 0, costUsd: null },
      { stepIndex: 1 },
      { stepIndex: 2, costUsd: 0.5 },
    ]);
    expect(seededCost).toBeCloseTo(0.5, 6);
    expect(skip.size).toBe(3);
  });
});
