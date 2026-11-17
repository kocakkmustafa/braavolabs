import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_RUN_SET_HASH, REAL_RUN_TASKS, REAL_RUN_TOTAL_TASKS, computeSetHash } from "../set";
import { REAL_RUN_PRICES, costMicroUsd } from "../pricing";
import { capToMicroUsd, liveGuardReasons, RealRunRefusal } from "../guards";
import { estimateRun, runRealRun, type ProviderCall, type Target } from "../runner";
import { makeFakeProvider } from "../fake-provider";
import { scoreAnswer } from "../scoring";
import { runCli } from "../cli";

const PINNED_HASH = "a55cf8dd899d79492267c3ab585a5d56fe32981d6185573559985a233cc86a3f";
const TARGETS: Target[] = [
  { provider: "ANTHROPIC", model: "claude-sonnet-5-5" },
  { provider: "OPENAI", model: "gpt-4o" },
  { provider: "GOOGLE", model: "gemini-1.5-pro" },
];
const SENTINEL = "sk-SENTINEL-do-not-leak-0123456789";

describe("real-run set", () => {
  it("has 30 tasks and a stable, pinned setHash", () => {
    expect(REAL_RUN_TOTAL_TASKS).toBe(30);
    expect(computeSetHash()).toBe(REAL_RUN_SET_HASH);
    expect(computeSetHash()).toBe(computeSetHash());
    expect(REAL_RUN_SET_HASH).toBe(PINNED_HASH);
  });
  it("hash changes when a task changes", () => {
    const mod = REAL_RUN_TASKS.map((t, i) => (i === 0 ? { ...t, maxTokens: t.maxTokens + 1 } : t));
    expect(computeSetHash(mod)).not.toBe(REAL_RUN_SET_HASH);
  });
});

describe("cost math", () => {
  it("is integer micro-USD, rounded up", () => {
    const c = costMicroUsd(1234, 567, { inputPerM: 0.075, outputPerM: 0.3 });
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBe(Math.ceil((1234 * 75 + 567 * 300) / 1000));
    expect(costMicroUsd(1_000_000, 1_000_000, { inputPerM: 2, outputPerM: 10 })).toBe(12_000_000);
  });
});

describe("cap guards", () => {
  it("rejects capUsd above 20 and invalid values", () => {
    expect(() => capToMicroUsd(20.01)).toThrow(RealRunRefusal);
    expect(() => capToMicroUsd(0)).toThrow(RealRunRefusal);
    expect(() => capToMicroUsd(NaN)).toThrow(RealRunRefusal);
    expect(capToMicroUsd(undefined)).toBe(20_000_000);
    expect(capToMicroUsd(5)).toBe(5_000_000);
  });
  it("runner refuses cap above 20", async () => {
    const f = makeFakeProvider();
    await expect(runRealRun({ mode: "dry-run", targets: TARGETS, call: f.call, now: f.now, capUsd: 21 })).rejects.toThrow(/hard limit/);
  });
  it("live needs flag, approval env and every key", () => {
    const base = { live: true, providers: ["ANTHROPIC", "OPENAI"], understandSpend: true };
    expect(liveGuardReasons({ ...base, env: {} }).length).toBe(3);
    expect(liveGuardReasons({ ...base, understandSpend: false, env: { BENCH_REAL_RUN_APPROVED: "1", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" } })).toEqual([
      "missing flag --i-understand-spend",
    ]);
    expect(liveGuardReasons({ ...base, env: { BENCH_REAL_RUN_APPROVED: "1", BENCH_ANTHROPIC_KEY: "x", OPENAI_API_KEY: "y" } })).toEqual([]);
    expect(liveGuardReasons({ ...base, live: false, env: {} })).toEqual([]);
  });
});

describe("runner", () => {
  it("dry-run end to end with the fake provider", async () => {
    const f = makeFakeProvider();
    const r = await runRealRun({ mode: "dry-run", targets: TARGETS, call: f.call, now: f.now });
    expect(r.status).toBe("COMPLETED");
    expect(r.mode).toBe("dry-run");
    expect(r.setHash).toBe(REAL_RUN_SET_HASH);
    expect(f.calls()).toBe(90);
    expect(Number.isInteger(r.spentMicroUsd)).toBe(true);
    expect(r.spentMicroUsd).toBeGreaterThan(0);
    expect(r.spentMicroUsd).toBeLessThanOrEqual(r.estimate.totalMicroUsd);
    for (const t of r.targets) {
      expect(t.tasks).toHaveLength(30);
      expect(t.meanScore).not.toBeNull();
      expect(t.tasks.every((k) => Number.isInteger(k.costMicroUsd) && k.latencyMs !== null)).toBe(true);
    }
  });

  it("aborts when the pre-estimate exceeds the cap, with zero calls", async () => {
    let calls = 0;
    const call: ProviderCall = async () => { calls++; return { content: "x", inputTokens: 1, outputTokens: 1 }; };
    const est = estimateRun(REAL_RUN_TASKS, TARGETS).totalMicroUsd;
    const r = await runRealRun({ mode: "dry-run", targets: TARGETS, call, now: () => 0, capUsd: est / 1_000_000 / 2 });
    expect(r.status).toBe("ABORT_ESTIMATE_OVER_CAP");
    expect(calls).toBe(0);
    expect(r.spentMicroUsd).toBe(0);
  });

  it("stops at 90% of the cap and reports partial results", async () => {
    // Cap just above the estimate; real usage per call is large, so spend
    // reaches 90% before all tasks run.
    const est = estimateRun(REAL_RUN_TASKS, [TARGETS[0]]).totalMicroUsd;
    const cap = est / 1_000_000 + 0.000001;
    let calls = 0;
    const big: ProviderCall = async () => { calls++; return { content: "AUTO", inputTokens: 1000, outputTokens: 1500 }; };
    const r = await runRealRun({ mode: "dry-run", targets: [TARGETS[0]], call: big, now: () => 0, capUsd: cap });
    expect(r.status).toBe("STOPPED_AT_CAP");
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(30);
    const recs = r.targets[0].tasks;
    expect(recs.filter((k) => k.status === "ok").length).toBe(calls);
    expect(recs.filter((k) => k.status === "not_run").length).toBe(30 - calls);
    // no call started at or past 90%
    const stopAt = Math.floor(r.capMicroUsd * 0.9);
    const spentBeforeLast = r.spentMicroUsd - recs.filter((k) => k.status === "ok").slice(-1)[0].costMicroUsd;
    expect(spentBeforeLast).toBeLessThan(stopAt);
    expect(r.spentMicroUsd).toBeLessThanOrEqual(r.capMicroUsd);
  });

  it("retries a failing call at most once, then records a constant error code", async () => {
    let n = 0;
    const call: ProviderCall = async () => { n++; throw new Error(`boom ${SENTINEL}`); };
    const r = await runRealRun({ mode: "dry-run", targets: [TARGETS[0]], call, now: () => 0 });
    expect(n).toBe(60); // 30 tasks x (1 + 1 retry)
    const t = r.targets[0].tasks[0];
    expect(t.status).toBe("error");
    expect(t.attempts).toBe(2);
    expect(t.errorCode).toBe("PROVIDER_ERROR");
    expect(t.costEstimated).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("succeeds on the retry", async () => {
    let n = 0;
    const call: ProviderCall = async () => {
      n++;
      if (n === 1) throw new Error("transient");
      return { content: "APPROVE", inputTokens: 10, outputTokens: 10 };
    };
    const r = await runRealRun({ mode: "dry-run", targets: [TARGETS[0]], call, now: () => 0, tasks: REAL_RUN_TASKS.slice(0, 1) });
    expect(r.targets[0].tasks[0]).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("refuses an unpriced model", () => {
    expect(() => estimateRun(REAL_RUN_TASKS, [{ provider: "OPENAI", model: "nope" }])).toThrow(RealRunRefusal);
  });
});

describe("scoring", () => {
  it("label and keyword scorers", () => {
    expect(scoreAnswer({ kind: "label", expected: "APPROVE" }, "APPROVE - public")).toBe(1);
    expect(scoreAnswer({ kind: "label", expected: "APPROVE" }, "AUTO then APPROVE")).toBe(0);
    expect(scoreAnswer({ kind: "keywords", groups: [["a"], ["b"]] }, "A only")).toBe(0.5);
    expect(scoreAnswer({ kind: "keywords", groups: [["a"]], maxWords: 2 }, "a b c")).toBe(0);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "real-run-"));
  const sink = () => { const lines: string[] = []; return { lines, io: { log: (l: string) => void lines.push(l) } }; };

  it("defaults to dry-run and writes JSON + Markdown", async () => {
    const s = sink();
    const r = await runCli(["--out", dir], {}, s.io);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, "bench-real-run.json"), "utf8"));
    expect(json.mode).toBe("dry-run");
    expect(readFileSync(join(dir, "bench-real-run.md"), "utf8")).toContain(REAL_RUN_SET_HASH);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires --out", async () => {
    const s = sink();
    expect((await runCli([], {}, s.io)).exitCode).toBe(2);
  });

  it("refuses --live without flags/env/keys and never touches the live adapter", async () => {
    const s = sink();
    let touched = false;
    const r = await runCli(["--live", "--out", dir], { ANTHROPIC_API_KEY: SENTINEL }, s.io, () => { touched = true; return async () => ({ content: "", inputTokens: 0, outputTokens: 0 }); });
    expect(r.exitCode).toBe(2);
    expect(touched).toBe(false);
    expect(s.lines.join("\n")).not.toContain(SENTINEL);
  });

  it("refuses cap above 20", async () => {
    const s = sink();
    expect((await runCli(["--out", dir, "--cap-usd", "25"], {}, s.io)).exitCode).toBe(2);
  });

  it("live mode with all guards: key value never reaches output or reports", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "real-run-live-"));
    const s = sink();
    const env = {
      BENCH_REAL_RUN_APPROVED: "1",
      ANTHROPIC_API_KEY: SENTINEL, OPENAI_API_KEY: SENTINEL + "o", GOOGLE_API_KEY: SENTINEL + "g",
    };
    // Stub provider (no network) that would echo the key if anything leaked.
    const stub = (e: Record<string, string | undefined>): ProviderCall => async () => {
      void e;
      return { content: "AUTO", inputTokens: 50, outputTokens: 20 };
    };
    const r = await runCli(["--live", "--i-understand-spend", "--out", d2], env, s.io, stub);
    expect(r.exitCode).toBe(0);
    expect(r.report?.mode).toBe("live");
    const all = [s.lines.join("\n"), readFileSync(join(d2, "bench-real-run.json"), "utf8"), readFileSync(join(d2, "bench-real-run.md"), "utf8")].join("\n");
    expect(all).not.toContain("SENTINEL");
    // no prompt text either: pick a distinctive phrase from a prompt
    expect(all).not.toContain("LinkedIn ad targeting");
    rmSync(d2, { recursive: true, force: true });
  });
});

describe("price table sanity", () => {
  it("covers default models", () => {
    for (const t of TARGETS) expect(REAL_RUN_PRICES[`${t.provider}/${t.model}`]).toBeDefined();
  });
});
