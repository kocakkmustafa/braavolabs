import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_RUN_SET_HASH, REAL_RUN_TASKS, REAL_RUN_TOTAL_TASKS, computeSetHash } from "../set";
import { REAL_RUN_PRICES, costMicroUsd, estimateTokens, worstCaseMicroUsd } from "../pricing";
import { PROVIDER_RETRY_FACTOR, capToMicroUsd, liveGuardReasons, RealRunRefusal } from "../guards";
import { estimateRun, runRealRun, type ProviderCall, type Target } from "../runner";
import { makeFakeProvider } from "../fake-provider";
import { SCORING_VERSION, scoreAnswer } from "../scoring";
import { parseArgs, runCli } from "../cli";
import { createLiveProvider } from "../live-provider";

const PINNED_HASH = "89d9abfad03831bd6ef255b4593c5cdff9144abe8333417e4e4b5b461b521085";
const TARGETS: Target[] = [
  { provider: "ANTHROPIC", model: "claude-sonnet-5-5" },
  { provider: "OPENAI", model: "gpt-4o" },
  { provider: "GOOGLE", model: "gemini-1.5-pro" },
];
const A = TARGETS[0];
const SENTINEL = "sk-SENTINEL-do-not-leak-0123456789";
const one = REAL_RUN_TASKS.slice(0, 1);

function singleWorst(task = REAL_RUN_TASKS[0], t = A): number {
  const price = REAL_RUN_PRICES[`${t.provider}/${t.model}`];
  return worstCaseMicroUsd(estimateTokens(task.system) + estimateTokens(task.prompt), task.maxTokens, price);
}

describe("real-run set", () => {
  it("has 30 tasks and a stable, pinned setHash", () => {
    expect(REAL_RUN_TOTAL_TASKS).toBe(30);
    expect(computeSetHash()).toBe(REAL_RUN_SET_HASH);
    expect(REAL_RUN_SET_HASH).toBe(PINNED_HASH);
    expect(SCORING_VERSION).toBe("2");
  });
  it("hash changes with a task or the version", () => {
    const mod = REAL_RUN_TASKS.map((t, i) => (i === 0 ? { ...t, maxTokens: t.maxTokens + 1 } : t));
    expect(computeSetHash(mod)).not.toBe(REAL_RUN_SET_HASH);
    expect(computeSetHash(REAL_RUN_TASKS, "9.9.9")).not.toBe(REAL_RUN_SET_HASH);
  });
});

describe("pricing", () => {
  it("is integer micro-USD, rounded up", () => {
    const c = costMicroUsd(1234, 567, { inputPerM: 0.075, outputPerM: 0.3 });
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBe(Math.ceil((1234 * 75 + 567 * 300) / 1000));
    expect(costMicroUsd(1_000_000, 1_000_000, { inputPerM: 2, outputPerM: 10 })).toBe(12_000_000);
  });
  it("every price carries asOf and source", () => {
    for (const p of Object.values(REAL_RUN_PRICES)) {
      expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source.length).toBeGreaterThan(0);
    }
  });
});

describe("cap guards", () => {
  it("rejects capUsd above 20 and invalid values", () => {
    expect(() => capToMicroUsd(20.01)).toThrow(RealRunRefusal);
    expect(() => capToMicroUsd(0)).toThrow(RealRunRefusal);
    expect(() => capToMicroUsd(NaN)).toThrow(RealRunRefusal);
    expect(capToMicroUsd(undefined)).toBe(20_000_000);
  });
  it("runner refuses cap above 20", async () => {
    const f = makeFakeProvider();
    await expect(runRealRun({ mode: "dry-run", targets: TARGETS, call: f.call, now: f.now, capUsd: 21 })).rejects.toThrow(/hard limit/);
  });
  it("live needs flag, approval env and every key", () => {
    const base = { live: true, providers: ["ANTHROPIC", "OPENAI"], understandSpend: true };
    expect(liveGuardReasons({ ...base, env: {} }).length).toBe(3);
    expect(liveGuardReasons({ ...base, env: { BENCH_REAL_RUN_APPROVED: "1", BENCH_ANTHROPIC_KEY: "x", OPENAI_API_KEY: "y" } })).toEqual([]);
    expect(liveGuardReasons({ ...base, live: false, env: {} })).toEqual([]);
  });
});

describe("runner", () => {
  it("dry-run end to end with the fake provider", async () => {
    const f = makeFakeProvider();
    const r = await runRealRun({ mode: "dry-run", targets: TARGETS, call: f.call, now: f.now });
    expect(r.status).toBe("COMPLETED");
    expect(r.setHash).toBe(REAL_RUN_SET_HASH);
    expect(r.scoringVersion).toBe(SCORING_VERSION);
    expect(r.providerRetryFactor).toBe(PROVIDER_RETRY_FACTOR);
    expect(r.warnings.join("|")).toMatch(/not verified by the founder/);
    expect(f.calls()).toBe(90);
    expect(Number.isInteger(r.spentMicroUsd)).toBe(true);
    expect(r.spentMicroUsd).toBeLessThanOrEqual(r.estimate.totalMicroUsd);
    for (const t of r.targets) {
      expect(t.tasks).toHaveLength(30);
      expect(t.priceAsOf).not.toBeNull();
      expect(t.meanScore).not.toBeNull();
    }
  });

  it("estimate multiplies by provider retry factor and wrapper retry", () => {
    const e = estimateRun(one, [A]).totalMicroUsd;
    expect(e).toBe(singleWorst() * PROVIDER_RETRY_FACTOR * 2);
    expect(PROVIDER_RETRY_FACTOR).toBe(3);
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

  it("stops at 90% of the cap with a partial report", async () => {
    const est = estimateRun(REAL_RUN_TASKS, [A]).totalMicroUsd;
    let calls = 0;
    // each call really costs ~1/20 of the cap, so 90% is reached after ~18 of 30 tasks
    const outTokens = Math.ceil(est / 20 / 10);
    const big: ProviderCall = async () => { calls++; return { content: "AUTO", inputTokens: 10, outputTokens: outTokens }; };
    const r = await runRealRun({ mode: "dry-run", targets: [A], call: big, now: () => 0, capUsd: est / 1_000_000 });
    expect(r.status).toBe("STOPPED_AT_CAP");
    expect(calls).toBeGreaterThanOrEqual(17);
    expect(calls).toBeLessThan(30);
    const recs = r.targets[0].tasks;
    expect(recs.filter((k) => k.status === "ok").length).toBe(calls);
    expect(recs.filter((k) => k.status === "not_run").length).toBe(30 - calls);
    expect(r.spentMicroUsd).toBeLessThanOrEqual(r.capMicroUsd);
  });

  it("stops when one more call could cross the cap even below 90%", async () => {
    const two = REAL_RUN_TASKS.slice(0, 2);
    const est = estimateRun(two, [A]).totalMicroUsd;
    // First call really costs ~80% of the cap (output $10/M = 10 micro-USD per token).
    const outTokens = Math.ceil((est * 0.8) / 10);
    let calls = 0;
    const call: ProviderCall = async () => { calls++; return { content: "AUTO", inputTokens: 10, outputTokens: outTokens }; };
    const r = await runRealRun({ mode: "dry-run", targets: [A], call, now: () => 0, capUsd: est / 1_000_000, tasks: two });
    expect(calls).toBe(1);
    expect(r.status).toBe("STOPPED_AT_CAP");
    expect(r.spentMicroUsd).toBeLessThan(Math.floor(r.capMicroUsd * 0.9)); // not the 90% branch
    expect(r.spentMicroUsd + singleWorst(two[1]) * PROVIDER_RETRY_FACTOR).toBeGreaterThan(r.capMicroUsd);
    expect(r.targets[0].tasks[1].status).toBe("not_run");
  });

  it.each([
    ["0/0", { inputTokens: 0, outputTokens: 0 }],
    ["NaN", { inputTokens: NaN, outputTokens: 5 }],
    ["negative", { inputTokens: -5, outputTokens: 10 }],
    ["missing", {} as { inputTokens: number; outputTokens: number }],
  ])("unreliable usage (%s) is charged the worst case, not zero", async (_n, usage) => {
    const call: ProviderCall = async () => ({ content: "AUTO", ...usage }) as never;
    const r = await runRealRun({ mode: "dry-run", targets: [A], call, now: () => 0, tasks: one });
    const rec = r.targets[0].tasks[0];
    expect(rec.status).toBe("ok");
    expect(rec.costMicroUsd).toBe(singleWorst());
    expect(rec.costEstimated).toBe(true);
    expect(r.spentMicroUsd).toBe(singleWorst());
  });

  it("input larger than the estimate is counted as really reported", async () => {
    const call: ProviderCall = async () => ({ content: "AUTO", inputTokens: 500_000, outputTokens: 10 });
    const r = await runRealRun({ mode: "dry-run", targets: [A], call, now: () => 0, tasks: one, capUsd: 20 });
    const rec = r.targets[0].tasks[0];
    expect(rec.costMicroUsd).toBe(costMicroUsd(500_000, 10, REAL_RUN_PRICES["ANTHROPIC/claude-sonnet-5-5"]));
    expect(rec.costMicroUsd).toBeGreaterThan(singleWorst());
    expect(rec.costEstimated).toBe(false);
  });

  it("GOOGLE is charged max(reported, worst) and flagged", async () => {
    const g = TARGETS[2];
    const call: ProviderCall = async () => ({ content: "AUTO", inputTokens: 5, outputTokens: 5 });
    const r = await runRealRun({ mode: "dry-run", targets: [g], call, now: () => 0, tasks: one });
    const rec = r.targets[0].tasks[0];
    expect(rec.costMicroUsd).toBe(singleWorst(REAL_RUN_TASKS[0], g));
    expect(rec.costEstimated).toBe(true);
    expect(r.warnings.join("|")).toMatch(/GOOGLE/);
    // a reported cost above the worst case is kept as is
    const huge: ProviderCall = async () => ({ content: "AUTO", inputTokens: 5, outputTokens: 900_000 });
    const r2 = await runRealRun({ mode: "dry-run", targets: [g], call: huge, now: () => 0, tasks: one });
    expect(r2.targets[0].tasks[0].costMicroUsd).toBe(costMicroUsd(5, 900_000, REAL_RUN_PRICES["GOOGLE/gemini-1.5-pro"]));
  });

  it("runs round-robin across providers (one at a time)", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const call: ProviderCall = async (req) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`${req.provider}:${req.taskId}`);
      await Promise.resolve();
      inFlight--;
      return { content: "AUTO", inputTokens: 10, outputTokens: 10 };
    };
    await runRealRun({ mode: "dry-run", targets: TARGETS, call, now: () => 0, tasks: REAL_RUN_TASKS.slice(0, 2) });
    expect(order.map((o) => o.split(":")[0])).toEqual(["ANTHROPIC", "OPENAI", "GOOGLE", "ANTHROPIC", "OPENAI", "GOOGLE"]);
    expect(maxInFlight).toBe(1);
  });

  it("a cap stop leaves providers within one task of each other", async () => {
    const est = estimateRun(REAL_RUN_TASKS, TARGETS).totalMicroUsd;
    const big: ProviderCall = async () => ({ content: "AUTO", inputTokens: 10, outputTokens: Math.ceil(est / 60 / 10) });
    const r = await runRealRun({ mode: "dry-run", targets: TARGETS, call: big, now: () => 0, capUsd: est / 1_000_000 });
    expect(r.status).toBe("STOPPED_AT_CAP");
    const done = r.targets.map((t) => t.tasks.filter((k) => k.status === "ok").length);
    expect(Math.max(...done) - Math.min(...done)).toBeLessThanOrEqual(1);
    expect(r.targets.every((t) => t.tasks.some((k) => k.status === "not_run"))).toBe(true);
  });

  it("retries a failing call at most once, then records a constant error code", async () => {
    let n = 0;
    const call: ProviderCall = async () => { n++; throw new Error(`boom ${SENTINEL}`); };
    const r = await runRealRun({ mode: "dry-run", targets: [A], call, now: () => 0 });
    expect(n).toBe(60);
    const t = r.targets[0].tasks[0];
    expect(t).toMatchObject({ status: "error", attempts: 2, errorCode: "PROVIDER_ERROR", costEstimated: true });
    expect(t.costMicroUsd).toBe(singleWorst() * PROVIDER_RETRY_FACTOR * 2);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("succeeds on the retry", async () => {
    let n = 0;
    const call: ProviderCall = async () => {
      n++;
      if (n === 1) throw new Error("transient");
      return { content: "APPROVE", inputTokens: 10, outputTokens: 10 };
    };
    const r = await runRealRun({ mode: "dry-run", targets: [A], call, now: () => 0, tasks: one });
    expect(r.targets[0].tasks[0]).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("refuses an unpriced model", () => {
    expect(() => estimateRun(REAL_RUN_TASKS, [{ provider: "OPENAI", model: "nope" }])).toThrow(RealRunRefusal);
  });
});

describe("scoring", () => {
  const kw = (groups: string[][], extra: object = {}) => ({ kind: "keywords" as const, groups, ...extra });
  it("label scorer is strict about position and ambiguity", () => {
    const s = { kind: "label" as const, expected: "APPROVE" as const };
    expect(scoreAnswer(s, "APPROVE - public")).toBe(1);
    expect(scoreAnswer(s, "**APPROVE** because")).toBe(1);
    expect(scoreAnswer(s, "AUTO then APPROVE")).toBe(0);
    expect(scoreAnswer(s, "APPROVE / AUTO / REFUSE")).toBe(0);
    expect(scoreAnswer(s, "I think it should be APPROVE")).toBe(0);
  });
  it("uses word boundaries, stems and counts each group once", () => {
    const prose = (t: string) => `The result is that ${t} in the case.`;
    expect(scoreAnswer(kw([["step 2"]]), prose("step 20 failed"))).toBe(0);
    expect(scoreAnswer(kw([["step 2"]]), prose("step 2 failed"))).toBe(1);
    expect(scoreAnswer(kw([["refus*"]]), prose("it will refuse the request"))).toBe(1);
    expect(scoreAnswer(kw([["port"]]), prose("the airport is open"))).toBe(0);
    expect(scoreAnswer(kw([["a1"], ["b1"]]), prose("a1 a1 a1 a1"))).toBe(0.5);
  });
  it("does not count negated hits", () => {
    const s = kw([["refus*"]]);
    expect(scoreAnswer(s, "The agent should not refuse to help here and it is fine.")).toBe(0);
    expect(scoreAnswer(s, "The agent must refuse the transfer and it is the rule.")).toBe(1);
  });
  it("cuts and halves answers over maxChars", () => {
    const filler = "the ".repeat(40);
    const s = kw([["alpha"]], { maxChars: 100 });
    expect(scoreAnswer(s, `alpha is the one ${filler}`)).toBe(0.5);
    expect(scoreAnswer(s, `${filler}alpha is the one`)).toBe(0);
    expect(scoreAnswer(kw([["alpha"]], { maxWords: 3 }), "alpha is the one")).toBe(0);
  });
  it("keyword stuffing scores low on every keyword task", async () => {
    const stuff = makeFakeProvider({ stuff: true });
    for (const t of REAL_RUN_TASKS.filter((k) => k.scorer.kind === "keywords")) {
      const res = await stuff.call({ taskId: t.id, provider: "X", model: "y", system: t.system, prompt: t.prompt, maxTokens: t.maxTokens });
      expect(scoreAnswer(t.scorer, res.content)).toBeLessThanOrEqual(0.25);
    }
  });
  it("prose answers carrying the right points still score", async () => {
    const f = makeFakeProvider();
    const scores: number[] = [];
    for (const t of REAL_RUN_TASKS.filter((k) => k.scorer.kind === "keywords")) {
      const res = await f.call({ taskId: t.id, provider: "X", model: "y", system: t.system, prompt: t.prompt, maxTokens: t.maxTokens });
      scores.push(scoreAnswer(t.scorer, res.content));
    }
    expect(Math.max(...scores)).toBe(1);
  });
});

describe("live provider adapter (stub chat, no network)", () => {
  const sink = () => { const calls: unknown[][] = []; return { calls }; };
  it("maps model, key (trimmed), messages, maxTokens and usage", async () => {
    const s = sink();
    const call = await createLiveProvider({ ANTHROPIC_API_KEY: `  ${SENTINEL}  ` }, {
      loadChat: async () => async (...args) => { s.calls.push(args); return { content: "APPROVE", inputTokens: 11, outputTokens: 7 }; },
    });
    const res = await call({ taskId: "t", provider: "ANTHROPIC", model: "claude-sonnet-5-5", system: "SYS", prompt: "P", maxTokens: 123 });
    expect(res).toEqual({ content: "APPROVE", inputTokens: 11, outputTokens: 7 });
    expect(s.calls[0]).toEqual([
      { provider: "ANTHROPIC", model: "claude-sonnet-5-5", apiKey: SENTINEL },
      "SYS", [{ role: "user", content: "P" }], 123,
    ]);
  });
  it("BENCH_<P>_KEY wins; missing key rejects", async () => {
    const s = sink();
    const call = await createLiveProvider({ BENCH_OPENAI_KEY: "bench", OPENAI_API_KEY: "sys" }, {
      loadChat: async () => async (...args) => { s.calls.push(args); return { content: "", inputTokens: 1, outputTokens: 1 }; },
    });
    await call({ taskId: "t", provider: "OPENAI", model: "gpt-4o", system: "", prompt: "", maxTokens: 1 });
    expect((s.calls[0][0] as { apiKey: string }).apiKey).toBe("bench");
    await expect(call({ taskId: "t", provider: "GOOGLE", model: "m", system: "", prompt: "", maxTokens: 1 })).rejects.toThrow();
  });
  it("provider error becomes PROVIDER_ERROR in the report (no raw text)", async () => {
    const call = await createLiveProvider({ ANTHROPIC_API_KEY: SENTINEL }, {
      loadChat: async () => async () => { throw new Error(`401 ${SENTINEL}`); },
    });
    const r = await runRealRun({ mode: "live", targets: [A], call, now: () => 0, tasks: one });
    expect(r.targets[0].tasks[0]).toMatchObject({ status: "error", errorCode: "PROVIDER_ERROR" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
  it("times out a hanging call", async () => {
    const call = await createLiveProvider({ ANTHROPIC_API_KEY: "k" }, {
      timeoutMs: 20,
      loadChat: async () => () => new Promise(() => undefined),
    });
    await expect(call({ taskId: "t", provider: "ANTHROPIC", model: "m", system: "", prompt: "", maxTokens: 1 })).rejects.toThrow("timeout");
  });
  it("env schema failure becomes ENV_CONFIG_INVALID with paths only", async () => {
    const zodLike = Object.assign(new Error(`bad ${SENTINEL}`), { issues: [{ path: ["DATABASE_URL"] }, { path: ["JWT_SECRET"] }] });
    await expect(createLiveProvider({}, { loadChat: async () => { throw zodLike; } })).rejects.toMatchObject({ code: "ENV_CONFIG_INVALID" });
    await expect(createLiveProvider({}, { loadChat: async () => { throw zodLike; } })).rejects.toThrow(/DATABASE_URL, JWT_SECRET/);
  });
});

describe("CLI parsing", () => {
  it("strict: missing/invalid values and unknown flags are errors", () => {
    expect(() => parseArgs(["--cap-usd"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--cap-usd", "--live"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--cap-usd", "abc"])).toThrow(/number/);
    expect(() => parseArgs(["--cap-usd", "-5"])).toThrow(RealRunRefusal);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["stray"])).toThrow(/unexpected/);
    expect(parseArgs(["--cap-usd", "5"]).capUsd).toBe(5);
    expect(parseArgs([]).capUsd).toBe(20);
  });
  it("defaults to two providers; GOOGLE only with an explicit model", () => {
    expect(parseArgs([]).targets.map((t) => t.provider)).toEqual(["ANTHROPIC", "OPENAI"]);
    expect(() => parseArgs(["--providers", "ANTHROPIC,GOOGLE"])).toThrow(/--model-GOOGLE/);
    const t = parseArgs(["--model-google", "gemini-x"]).targets;
    expect(t.map((x) => `${x.provider}/${x.model}`)).toEqual(["ANTHROPIC/claude-sonnet-5-5", "OPENAI/gpt-4o", "GOOGLE/gemini-x"]);
  });
  it("--model-<provider> is case-insensitive, both forms", () => {
    expect(parseArgs(["--model-openai=gpt-4o-mini"]).targets[1]).toEqual({ provider: "OPENAI", model: "gpt-4o-mini" });
    expect(parseArgs(["--model-OpenAI", "gpt-4o-mini"]).targets[1].model).toBe("gpt-4o-mini");
  });
});

describe("CLI", () => {
  const sink = () => { const lines: string[] = []; return { lines, io: { log: (l: string) => void lines.push(l) } }; };

  it("defaults to dry-run and writes JSON + Markdown with warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-run-"));
    const s = sink();
    const r = await runCli(["--out", dir], {}, s.io);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, "bench-real-run.json"), "utf8"));
    expect(json.mode).toBe("dry-run");
    expect(json.targets).toHaveLength(2);
    const md = readFileSync(join(dir, "bench-real-run.md"), "utf8");
    expect(md).toContain(REAL_RUN_SET_HASH);
    expect(md).toMatch(/WARNING: prices not verified/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires --out; refuses bad args and cap above 20", async () => {
    expect((await runCli([], {}, sink().io)).exitCode).toBe(2);
    expect((await runCli(["--out", "x", "--cap-usd"], {}, sink().io)).exitCode).toBe(2);
    expect((await runCli(["--out", "x", "--cap-usd", "25"], {}, sink().io)).exitCode).toBe(2);
    expect((await runCli(["--out", "x", "--nope"], {}, sink().io)).exitCode).toBe(2);
  });

  it("refuses --live without flags/env/keys and never touches the live adapter", async () => {
    const s = sink();
    let touched = false;
    const r = await runCli(["--live", "--out", "x"], { ANTHROPIC_API_KEY: SENTINEL }, s.io, () => { touched = true; return async () => ({ content: "", inputTokens: 0, outputTokens: 0 }); });
    expect(r.exitCode).toBe(2);
    expect(touched).toBe(false);
    expect(s.lines.join("\n")).not.toContain(SENTINEL);
  });

  it("live: lists models up front, key value never reaches output or reports", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "real-run-live-"));
    const s = sink();
    const env = { BENCH_REAL_RUN_APPROVED: "1", ANTHROPIC_API_KEY: SENTINEL, OPENAI_API_KEY: SENTINEL + "o", GOOGLE_API_KEY: SENTINEL + "g" };
    const stub = (): ProviderCall => async () => ({ content: "AUTO", inputTokens: 50, outputTokens: 20 });
    const r = await runCli(["--live", "--i-understand-spend", "--out", d2, "--model-GOOGLE", "gemini-1.5-pro"], env, s.io, stub);
    expect(r.exitCode).toBe(0);
    expect(r.report?.mode).toBe("live");
    expect(r.report?.targets).toHaveLength(3);
    expect(s.lines[0]).toContain("ANTHROPIC/claude-sonnet-5-5, OPENAI/gpt-4o, GOOGLE/gemini-1.5-pro");
    expect(s.lines.join("\n")).toMatch(/prices not verified/);
    const all = [s.lines.join("\n"), readFileSync(join(d2, "bench-real-run.json"), "utf8"), readFileSync(join(d2, "bench-real-run.md"), "utf8")].join("\n");
    expect(all).not.toContain("SENTINEL");
    expect(all).not.toContain("LinkedIn ad targeting");
    rmSync(d2, { recursive: true, force: true });
  });

  it("live: env schema failure prints ENV_CONFIG_INVALID with paths, exit 2, no values", async () => {
    const s = sink();
    const env = { BENCH_REAL_RUN_APPROVED: "1", ANTHROPIC_API_KEY: SENTINEL, OPENAI_API_KEY: SENTINEL };
    const zodLike = Object.assign(new Error(`bad ${SENTINEL}`), { issues: [{ path: ["DATABASE_URL"] }] });
    const r = await runCli(["--live", "--i-understand-spend", "--out", "x"], env, s.io,
      (e) => createLiveProvider(e, { loadChat: async () => { throw zodLike; } }));
    expect(r.exitCode).toBe(2);
    const out = s.lines.join("\n");
    expect(out).toContain("ENV_CONFIG_INVALID: DATABASE_URL");
    expect(out).not.toContain("SENTINEL");
  });
});
