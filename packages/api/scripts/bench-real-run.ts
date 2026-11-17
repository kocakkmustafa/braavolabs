/**
 * Bench real-run harness (BRA-P1-05-N3). Default: --dry-run (fake provider,
 * no network).
 *
 *   pnpm --filter @ai-company-os/api exec tsx scripts/bench-real-run.ts --dry-run --out <dir>
 *
 * Live (founder only; spends real money, hard cap 20 USD):
 *   BENCH_REAL_RUN_APPROVED=1 <provider key env vars> \
 *   pnpm --filter @ai-company-os/api exec tsx scripts/bench-real-run.ts \
 *     --live --i-understand-spend --out <dir> [--cap-usd N] [--providers A,B]
 *
 * Optional: --model-<PROVIDER>=<model id> (must exist in real-run/pricing.ts).
 */
import { runCli } from "../src/modules/bench/real-run/cli";

runCli(process.argv.slice(2), process.env, { log: (l) => console.log(l) }).then(
  (r) => process.exit(r.exitCode),
  () => process.exit(1),
);
