import { describe, it, expect, vi } from "vitest";
import { runCascade, type CascadeRunner } from "../cascade";
import type { ModelSpec, RouteRequest } from "../routing";

const local: ModelSpec = { id: "gemma-local", tier: "local", costPer1kIn: 0, costPer1kOut: 0, capabilities: ["chat"] };
const cheap: ModelSpec = { id: "glm-flash", tier: "cheap", costPer1kIn: 0.0002, costPer1kOut: 0.0006, capabilities: ["chat"] };
const frontier: ModelSpec = { id: "opus", tier: "frontier", costPer1kIn: 0.015, costPer1kOut: 0.075, capabilities: ["chat"] };
const models = [local, cheap, frontier];
const req: RouteRequest = { taskType: "chat", requiredCapabilities: ["chat"] };

/** Runner keyed by model id → fixed {confidence, cost}. */
function runnerFrom(map: Record<string, { confidence: number; costUsd?: number }>): CascadeRunner {
  return vi.fn(async (m: ModelSpec) => ({
    answer: `answer from ${m.id}`,
    confidence: map[m.id]?.confidence ?? 0,
    costUsd: map[m.id]?.costUsd ?? 0,
  }));
}

describe("runCascade — triage-first with escalate-on-low-confidence", () => {
  it("stops at the cheapest capable model when it is confident (no escalation)", async () => {
    const run = runnerFrom({ "gemma-local": { confidence: 0.9, costUsd: 0 } });
    const res = await runCascade(req, models, run);
    expect(res.attempts).toHaveLength(1);
    expect(res.model.id).toBe("gemma-local");
    expect(res.escalated).toBe(false);
    expect(res.stoppedReason).toBe("confident");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("escalates to the next tier on low confidence and returns the confident higher-tier answer", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.3, costUsd: 0.001 },
      "glm-flash": { confidence: 0.85, costUsd: 0.002 },
    });
    const res = await runCascade(req, models, run);
    expect(res.attempts.map((a) => a.model.id)).toEqual(["gemma-local", "glm-flash"]);
    expect(res.model.id).toBe("glm-flash");
    expect(res.escalated).toBe(true);
    expect(res.stoppedReason).toBe("confident");
    expect(res.answer).toBe("answer from glm-flash");
  });

  it("escalates all the way to the frontier when nothing clears the threshold, best = highest confidence", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.2, costUsd: 0 },
      "glm-flash": { confidence: 0.4, costUsd: 0.001 },
      "opus": { confidence: 0.6, costUsd: 0.05 },
    });
    const res = await runCascade(req, models, run);
    expect(res.attempts).toHaveLength(3);
    expect(res.stoppedReason).toBe("frontier-reached");
    expect(res.model.id).toBe("opus"); // highest confidence (0.6)
    expect(res.escalated).toBe(true);
  });

  it("forces one escalation when a second opinion is requested, even if the first is confident", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.95, costUsd: 0 },
      "glm-flash": { confidence: 0.8, costUsd: 0.002 },
    });
    const res = await runCascade(req, models, run, { secondOpinion: true });
    expect(res.attempts).toHaveLength(2);
    expect(res.escalated).toBe(true);
    expect(res.model.id).toBe("gemma-local"); // best confidence (0.95) still wins
  });

  it("respects the budget cap: stops escalating once cumulative cost ≥ cap", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.1, costUsd: 0.5 },
      "glm-flash": { confidence: 0.1, costUsd: 0.5 },
      "opus": { confidence: 0.1, costUsd: 0.5 },
    });
    const res = await runCascade(req, models, run, { budgetUsdCap: 0.6 });
    // 1st attempt 0.5 (< cap → escalate), 2nd attempt total 1.0 (≥ cap → stop).
    expect(res.attempts).toHaveLength(2);
    expect(res.stoppedReason).toBe("budget-cap");
    expect(res.totalCostUsd).toBeCloseTo(1.0, 6);
  });

  it("starts at the frontier for hard tasks (routeTask honors req.hard)", async () => {
    const run = runnerFrom({ "opus": { confidence: 0.9, costUsd: 0.05 } });
    const res = await runCascade({ ...req, hard: true }, models, run);
    expect(res.attempts).toHaveLength(1);
    expect(res.model.id).toBe("opus");
    expect(res.escalated).toBe(false);
  });

  it("sums total cost across every attempt", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.1, costUsd: 0.01 },
      "glm-flash": { confidence: 0.1, costUsd: 0.02 },
      "opus": { confidence: 0.9, costUsd: 0.04 },
    });
    const res = await runCascade(req, models, run);
    expect(res.model.id).toBe("opus");
    expect(res.totalCostUsd).toBeCloseTo(0.07, 6);
  });

  it("respects maxAttempts as a safety bound", async () => {
    const run = runnerFrom({
      "gemma-local": { confidence: 0.1 },
      "glm-flash": { confidence: 0.1 },
      "opus": { confidence: 0.1 },
    });
    const res = await runCascade(req, models, run, { maxAttempts: 2 });
    expect(res.attempts).toHaveLength(2);
    expect(res.stoppedReason).toBe("max-attempts");
  });
});
