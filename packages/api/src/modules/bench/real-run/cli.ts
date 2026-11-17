/**
 * CLI logic for scripts/bench-real-run.ts (testable: argv/env/io injected).
 * Default is --dry-run (fake provider, no network). `--live` needs
 * `--i-understand-spend`, env BENCH_REAL_RUN_APPROVED=1 and a key in the
 * environment for each provider (presence only is checked/printed).
 *
 * Providers: default ANTHROPIC + OPENAI. GOOGLE (whose default model may be
 * retired) joins only with an explicit `--model-GOOGLE <id>`.
 * Arguments are strict: unknown flags, missing values and bad numbers are errors.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRICES_VERIFIED_BY_FOUNDER, PRICE_WARNING, REAL_RUN_DEFAULT_MODELS, REAL_RUN_DEFAULT_PROVIDERS } from "./pricing";
import { DEFAULT_CAP_USD, RealRunRefusal, liveGuardReasons } from "./guards";
import { makeFakeProvider } from "./fake-provider";
import { reportToMarkdown } from "./report";
import { runRealRun, type ProviderCall, type RealRunReport, type Target } from "./runner";

export interface CliIo {
  log: (line: string) => void;
}

export interface CliResult {
  exitCode: number;
  report?: RealRunReport;
}

export interface ParsedArgs {
  live: boolean;
  dryRun: boolean;
  understandSpend: boolean;
  out?: string;
  capUsd: number;
  targets: Target[];
}

const BOOL_FLAGS = new Set(["--live", "--dry-run", "--i-understand-spend"]);
const VALUE_FLAGS = new Set(["--out", "--cap-usd", "--providers"]);
const refuse = (code: string, msg: string): never => {
  throw new RealRunRefusal(code, msg);
};

export function parseArgs(argv: string[]): ParsedArgs {
  const bools = new Set<string>();
  const values = new Map<string, string>();
  const models = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) refuse("ARG_INVALID", `unexpected argument "${raw}"`);
    const eq = raw.indexOf("=");
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    let val: string | undefined = eq > 0 ? raw.slice(eq + 1) : undefined;
    if (BOOL_FLAGS.has(flag)) {
      if (val !== undefined) refuse("ARG_INVALID", `${flag} takes no value`);
      bools.add(flag);
      continue;
    }
    const isModel = flag.startsWith("--model-") && flag.length > "--model-".length;
    if (!VALUE_FLAGS.has(flag) && !isModel) refuse("ARG_INVALID", `unknown flag ${flag}`);
    if (val === undefined) {
      val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) refuse("ARG_INVALID", `${flag} needs a value`);
      i++;
    }
    const v = (val as string).trim();
    if (!v) refuse("ARG_INVALID", `${flag} needs a non-empty value`);
    if (isModel) models.set(flag.slice("--model-".length).toUpperCase(), v);
    else values.set(flag, v);
  }

  let capUsd = DEFAULT_CAP_USD;
  if (values.has("--cap-usd")) {
    const raw = values.get("--cap-usd") as string;
    capUsd = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(capUsd)) refuse("CAP_INVALID", "--cap-usd must be a number");
  }

  const explicit = values.get("--providers");
  const names = explicit
    ? explicit.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...REAL_RUN_DEFAULT_PROVIDERS];
  for (const m of models.keys()) if (!names.includes(m)) names.push(m);
  const unique = [...new Set(names)];
  if (unique.length === 0) refuse("ARG_INVALID", "no providers selected");

  const targets: Target[] = unique.map((provider) => {
    const model = models.get(provider) ?? (provider === "GOOGLE" ? undefined : REAL_RUN_DEFAULT_MODELS[provider]);
    if (!model) return refuse("MODEL_REQUIRED", `${provider} needs an explicit --model-${provider} <id>`);
    return { provider, model };
  });

  return {
    live: bools.has("--live"),
    dryRun: bools.has("--dry-run"),
    understandSpend: bools.has("--i-understand-spend"),
    out: values.get("--out"),
    capUsd,
    targets,
  };
}

export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  /** Test seam: replaces the live adapter (never used for network in tests). */
  liveFactory?: (env: Record<string, string | undefined>) => Promise<ProviderCall> | ProviderCall,
): Promise<CliResult> {
  try {
    const args = parseArgs(argv);
    if (args.live && args.dryRun) refuse("MODE_CONFLICT", "--live and --dry-run are exclusive");
    if (!args.out) refuse("OUT_REQUIRED", "--out <dir> is required");

    const reasons = liveGuardReasons({
      live: args.live, understandSpend: args.understandSpend, providers: args.targets.map((t) => t.provider), env,
    });
    if (reasons.length) {
      io.log(`REFUSED live run: ${reasons.join("; ")}`);
      return { exitCode: 2 };
    }

    io.log(`mode=${args.live ? "live" : "dry-run"} capUsd=${args.capUsd} targets: ${args.targets.map((t) => `${t.provider}/${t.model}`).join(", ")}`);
    if (!PRICES_VERIFIED_BY_FOUNDER) io.log(`WARNING: ${PRICE_WARNING}`);

    let call: ProviderCall;
    let now: () => number;
    if (args.live) {
      const mk = liveFactory ?? (async (e) => (await import("./live-provider")).createLiveProvider(e));
      call = await mk(env);
      now = Date.now;
    } else {
      const fake = makeFakeProvider();
      call = fake.call;
      now = fake.now;
    }

    const report = await runRealRun({ mode: args.live ? "live" : "dry-run", targets: args.targets, call, now, capUsd: args.capUsd });

    const dir = resolve(args.out as string);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bench-real-run.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(dir, "bench-real-run.md"), reportToMarkdown(report));
    io.log(
      `status=${report.status} setHash=${report.setHash} ` +
        `estimateUsd=${(report.estimate.totalMicroUsd / 1e6).toFixed(6)} spentUsd=${(report.spentMicroUsd / 1e6).toFixed(6)}`,
    );
    return { exitCode: report.status === "ABORT_ESTIMATE_OVER_CAP" ? 3 : 0, report };
  } catch (e) {
    if (e instanceof RealRunRefusal) {
      io.log(e.code === "ENV_CONFIG_INVALID" ? `ENV_CONFIG_INVALID: ${e.message}` : `REFUSED ${e.code}: ${e.message}`);
      return { exitCode: 2 };
    }
    io.log("FAILED: unexpected error");
    return { exitCode: 1 };
  }
}
