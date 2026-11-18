import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../bench.service", () => ({ runBenchSuite: vi.fn() }));
vi.mock("../../../services/multi-model", () => ({ MAX_CANDIDATES: 3 }));

import { runBenchSuite } from "../bench.service";
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
  vi.mocked(runBenchSuite).mockReset();
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
    expect(r.budgetExceeded).toBe(false);
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("one failing candidate is marked; the other two are unaffected", async () => {
    const runner = vi.fn(async (o: RunBenchOptions) => {
      if (o.model === "m-b") throw new Error("provider boom");
      return okRun(0.5)(o);
    });
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner, now: clock() });
    expect(r.records.map((x) => x.status)).toEqual(["ok", "error", "ok"]);
    expect(r.records[1]).toMatchObject({ error: "run failed: provider boom", scoreNormalised: null });
    expect(r.records[0].scoreNormalised).toBe(0.5);
    expect(r.records[2].scoreNormalised).toBe(0.5);
  });

  it("skipped (no key) is marked skipped with a constant reason", async () => {
    const runner = vi.fn(async (o: RunBenchOptions): Promise<RunBenchResult> =>
      o.model === "m-a"
        ? { skipped: true, provider: o.provider, model: o.model, reason: "set BENCH_X_KEY" }
        : okRun(1)(o),
    );
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, runner, now: clock() });
    expect(r.records[0]).toMatchObject({ status: "skipped", error: "provider not configured", scoreNormalised: null });
    expect(r.records[1].status).toBe("ok");
  });

  it("budget ceiling reached -> remaining candidates do not run", async () => {
    const runner = vi.fn(okRun(0.9, 0.6));
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, maxCostUsd: 1.0, runner, now: clock() });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(r.records.map((x) => x.status)).toEqual(["ok", "ok", "budget_skipped"]);
    expect(r.budgetExceeded).toBe(true);
  });

  it("uses runBenchSuite when no runner is given", async () => {
    vi.mocked(runBenchSuite).mockResolvedValue({ skipped: false, runId: "r", score: 0.4, cost: 0 });
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: [CANDS[0]], now: clock() });
    expect(runBenchSuite).toHaveBeenCalledTimes(1);
    expect(r.records[0].status).toBe("ok");
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("failures are charged a conservative estimate and trip the ceiling", async () => {
    const runner = vi.fn(async () => {
      throw new Error("boom");
    });
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, maxCostUsd: 0.6, runner, now: clock() });
    expect(r.records.every((x) => x.status === "error" && x.costUsd === null && x.costEstimated)).toBe(true);
    expect(r.totalCostUsd).toBeCloseTo(0.6);
    expect(r.budgetExceeded).toBe(false); // all ran; nothing skipped
    // ok(0.2) + error(estimate 0.1) reaches the 0.3 cap -> third is skipped
    let n = 0;
    const mixed = async (o: RunBenchOptions): Promise<RunBenchResult> => {
      if (n++ === 0) return okRun(1, 0.2)(o);
      throw new Error("boom");
    };
    const r2 = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, maxCostUsd: 0.3, runner: mixed, now: clock() });
    expect(r2.records.map((x) => x.status)).toEqual(["ok", "error", "budget_skipped"]);
    expect(r2.budgetExceeded).toBe(true);
  });

  it("NaN/negative cost -> estimate; score clamped to [0,1], NaN -> 0", async () => {
    const vals = [
      { score: 7, cost: Number.NaN },
      { score: -2, cost: -1 },
      { score: Number.NaN, cost: 0.1 },
    ];
    let i = 0;
    const runner = async (o: RunBenchOptions): Promise<RunBenchResult> => ({
      skipped: false,
      runId: o.model,
      ...vals[i++],
    });
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: CANDS, maxCostUsd: 30, runner, now: clock() });
    expect(r.records.map((x) => x.scoreNormalised)).toEqual([1, 0, 0]);
    expect(r.records[0]).toMatchObject({ costUsd: null, costEstimated: true });
    expect(r.records[2]).toMatchObject({ costUsd: 0.1, costEstimated: false });
    expect(r.totalCostUsd).toBeCloseTo(10 + 10 + 0.1);
  });

  it("rejects duplicates, empty list, over-limit, empty fields", async () => {
    const runner = vi.fn(okRun(1, 0));
    const go = (candidates: { provider: string; model: string }[], suiteSlug = "s") =>
      runAccuracyBench({ suiteSlug, candidates, runner });
    await expect(go([CANDS[0], CANDS[0]])).rejects.toThrow(/Duplicate/);
    await expect(go([])).rejects.toThrow();
    await expect(go([...CANDS, { provider: "GOOGLE", model: "m-d" }])).rejects.toThrow(/At most/);
    await expect(go([{ provider: "", model: "x" }])).rejects.toThrow();
    await expect(go([{ provider: "GROQ", model: " " }])).rejects.toThrow();
    await expect(go([CANDS[0]], "")).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("unknown provider is skipped without calling the runner", async () => {
    const runner = vi.fn(okRun(1, 0));
    const r = await runAccuracyBench({
      suiteSlug: "s",
      candidates: [{ provider: "NOPE", model: "x" }, CANDS[0]],
      runner,
      now: clock(),
    });
    expect(r.records[0]).toMatchObject({ status: "skipped", error: "provider not configured" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("error text is single-line, truncated, prefixed", async () => {
    const runner = async () => {
      throw new Error("a\nb " + "x".repeat(500));
    };
    const r = await runAccuracyBench({ suiteSlug: "s", candidates: [CANDS[0]], runner, now: clock() });
    const e = r.records[0].error!;
    expect(e).not.toMatch(/\n/);
    expect(e.length).toBeLessThanOrEqual(220);
    expect(e.startsWith("run failed:")).toBe(true);
  });
});
