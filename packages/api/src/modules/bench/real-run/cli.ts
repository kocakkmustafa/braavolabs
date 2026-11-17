/**
 * CLI logic for scripts/bench-real-run.ts (testable: argv/env/io injected).
 * Default is --dry-run (fake provider, no network). `--live` needs
 * `--i-understand-spend`, env BENCH_REAL_RUN_APPROVED=1 and a key in the
 * environment for each provider (presence only is checked/printed).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REAL_RUN_DEFAULT_MODELS } from "./pricing";
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

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  /** Test seam: replaces the live adapter (never used for network in tests). */
  liveFactory?: (env: Record<string, string | undefined>) => Promise<ProviderCall> | ProviderCall,
): Promise<CliResult> {
  try {
    const live = argv.includes("--live");
    if (live && argv.includes("--dry-run")) throw new RealRunRefusal("MODE_CONFLICT", "--live and --dry-run are exclusive");
    const out = flagValue(argv, "out");
    if (!out || out.startsWith("--")) throw new RealRunRefusal("OUT_REQUIRED", "--out <dir> is required");

    const providerNames = (flagValue(argv, "providers") ?? Object.keys(REAL_RUN_DEFAULT_MODELS).join(","))
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const targets: Target[] = providerNames.map((provider) => {
      const override = argv.find((a) => a.startsWith(`--model-${provider}=`));
      const model = override ? override.split("=").slice(1).join("=") : REAL_RUN_DEFAULT_MODELS[provider];
      if (!model) throw new RealRunRefusal("UNKNOWN_PROVIDER", `no default model for ${provider}; pass --model-${provider}=<id>`);
      return { provider, model };
    });

    const capRaw = flagValue(argv, "cap-usd");
    const capUsd = capRaw === undefined ? DEFAULT_CAP_USD : Number(capRaw);

    const reasons = liveGuardReasons({
      live, understandSpend: argv.includes("--i-understand-spend"), providers: providerNames, env,
    });
    if (reasons.length) {
      io.log(`REFUSED live run: ${reasons.join("; ")}`);
      return { exitCode: 2 };
    }

    let call: ProviderCall;
    let now: () => number;
    if (live) {
      const mk = liveFactory ?? (async (e) => (await import("./live-provider")).makeLiveProvider(e));
      call = await mk(env);
      now = Date.now;
    } else {
      const fake = makeFakeProvider();
      call = fake.call;
      now = fake.now;
    }

    const report = await runRealRun({ mode: live ? "live" : "dry-run", targets, call, now, capUsd });

    const dir = resolve(out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bench-real-run.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(dir, "bench-real-run.md"), reportToMarkdown(report));
    io.log(
      `mode=${report.mode} status=${report.status} setHash=${report.setHash} ` +
        `estimateUsd=${(report.estimate.totalMicroUsd / 1e6).toFixed(6)} spentUsd=${(report.spentMicroUsd / 1e6).toFixed(6)}`,
    );
    return { exitCode: report.status === "ABORT_ESTIMATE_OVER_CAP" ? 3 : 0, report };
  } catch (e) {
    if (e instanceof RealRunRefusal) {
      io.log(`REFUSED ${e.code}: ${e.message}`);
      return { exitCode: 2 };
    }
    io.log("FAILED: unexpected error");
    return { exitCode: 1 };
  }
}
