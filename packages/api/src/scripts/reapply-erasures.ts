/**
 * Restore runbook step: re-apply account erasures after restoring a backup.
 *
 *   node dist/scripts/reapply-erasures.js [--ledger <path-to-erasure-ledger.jsonl>] [--dry-run]
 *
 * Run once against the restored database BEFORE it serves traffic. The ledger
 * (ERASURE_LEDGER_PATH, kept outside database backups) supplies tombstones
 * written after the backup point. Prints counts only — never ids or rows.
 * --dry-run validates the ledger and exits without touching the database.
 */
import { readFile } from "node:fs/promises";
import { parseLedger, reapplyErasures } from "../modules/user/erasure-tombstones";

export function parseArgs(argv: string[]): { ledger?: string; dryRun: boolean } {
  const out: { ledger?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ledger" && argv[i + 1]) out.ledger = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

export async function main(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const ledger = args.ledger ? parseLedger(await readFile(args.ledger, "utf8")) : [];
  if (args.dryRun) return { dryRun: true, ledgerTombstones: ledger.length };
  return { dryRun: false, ...(await reapplyErasures({ ledger })) };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error: unknown) => {
      process.stderr.write(`reapply-erasures failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exit(1);
    });
}
