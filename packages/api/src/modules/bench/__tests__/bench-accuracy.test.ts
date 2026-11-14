import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../bench.service", () => ({ runBenchSuite: vi.fn() }));
vi.mock("../../../services/multi-model", () => ({ MAX_CANDIDATES: 3 }));

import { runAccuracyBench } from "../bench-accuracy";
import type { RunBenchOptions, RunBenchResult } from "../bench.service";

const CANDS = [
  { provider: "ANTHROPIC", model: "m-a" },
  { provider: "OPENAI", model: "m-b" },
  { provider: "GROQ", model: "m-c" },
];
const fetchGuard = vi.fn(() => {
  throw new Error("REAL NETWORK CALL ATTEMPTED");
});
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchGuard.mockClear();
  globalThis.fetch = fetchGuard as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function clock() {
  let t = 1000;
  return () => (t += 50);
}
const okRun = (score: number, cost = 0.1) =>
  async (o: RunBenchOptions): Promise<RunBenchResult> => ({ skipped: false, runId: `run-${o.model}`, score, cost });

describe("runAccuracyBench", () => {
  it("3 candidates -> 3 records with scoreNormalised and durationMs filled", async () => {
    const runner = vi.fn(okRun(0.8));
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner, now: clock() });
    expect(r.records).toHaveLength(3);
    for (const rec of r.records) {
      expect(rec.status).toBe("ok");
      expect(rec.scoreNormalised).toBeGreaterThanOrEqual(0);
      expect(rec.scoreNormalised).toBeLessThanOrEqual(1);
      expect(rec.durationMs).toBeGreaterThan(0);
      expect(rec.runId).toBe(`run-${rec.model}`);
    }
    expect(runner).toHaveBeenCalledTimes(3);
    expect(r.totalCostUsd).toBeCloseTo(0.3);
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("one failing candidate is marked; the other two are unaffected", async () => {
    const runner = vi.fn(async (o: RunBenchOptions) => {
      if (o.model === "m-b") throw new Error("provider boom");
      return okRun(0.5)(o);
    });
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner, now: clock() });
    expect(r.records.map((x) => x.status)).toEqual(["ok", "error", "ok"]);
    expect(r.records[1]).toMatchObject({ error: "provider boom", scoreNormalised: null });
    expect(r.records[0].scoreNormalised).toBe(0.5);
    expect(r.records[2].scoreNormalised).toBe(0.5);
  });

  it("skipped (no key) is marked skipped, not error", async () => {
    const runner = vi.fn(async (o: RunBenchOptions): Promise<RunBenchResult> =>
      o.model === "m-a" ? { skipped: true, provider: o.provider, model: o.model, reason: "no key" } : okRun(1)(o),
    );
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner, now: clock() });
    expect(r.records[0]).toMatchObject({ status: "skipped", error: "no key", scoreNormalised: null });
    expect(r.records[1].status).toBe("ok");
  });

  it("budget ceiling reached -> remaining candidates do not run", async () => {
    const runner = vi.fn(okRun(0.9, 0.6));
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, maxCostUsd: 1.0, runner, now: clock() });
    // 0.6 < 1.0 runs 2nd -> 1.2 >= 1.0 -> 3rd skipped
    expect(runner).toHaveBeenCalledTimes(2);
    expect(r.records.map((x) => x.status)).toEqual(["ok", "ok", "budget_skipped"]);
    expect(r.budgetExceeded).toBe(true);
  });

  it("caps candidates at MAX_CANDIDATES", async () => {
    const runner = vi.fn(okRun(1, 0));
    const r = await runAccuracyBench({
      suiteSlug: "s",
      candidates: [...CANDS, { provider: "GOOGLE", model: "m-d" }],
      runner,
      now: clock(),
    });
    expect(r.records).toHaveLength(3);
  });

  it("the default runner path is guarded: fetch is never reached with a fake runner", async () => {
    await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner: okRun(0.2), now: clock() });
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
