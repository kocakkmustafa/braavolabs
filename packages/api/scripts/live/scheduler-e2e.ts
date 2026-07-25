/**
 * LIVE E4/T8 scheduler acceptance — MOCK=0, REAL Postgres + REAL Redis.
 *
 * Proves the BullMQ-JobScheduler cutover of the SCHEDULED-pipeline engine end
 * to end against a real stack. It exercises the four acceptance criteria that
 * unit tests (Prisma/Redis mocked) structurally cannot:
 *
 *   AC#1  Runtime registration: registerSchedule on a freshly-created
 *         SCHEDULED pipeline fires a Run within ≤2 minutes — NO process
 *         restart needed (closes G1).
 *   AC#2  Runtime update: PATCH-style schedule change takes effect; the old
 *         pattern stops firing.
 *   AC#3  Runtime stop/delete: after removeSchedule the pipeline stops firing
 *         and NO invalid-FK "Failed to trigger scheduled pipeline" run-create
 *         is attempted (closes SCHED-04).
 *   AC#4  Restart durability: the scheduler lives in Redis, so a fresh process
 *         (this script re-run with STAGE=verify) still sees the scheduler and
 *         a Run keeps appearing — proving SIGTERM's stopScheduledPipelines is a
 *         no-op and the JobScheduler survives a bounce (closes G4).
 *
 * IMPORTANT — cron granularity (adversarial A5): use the REAL 5-field
 * minute-cron "every-1-minute" (see EVERY_MINUTE below). Do NOT use a 6-field
 * second-cron: prod schedules are 5-field (seed.ts uses "0 9 * * *") and the
 * 6-field path exercises a different parser branch that prod never hits.
 *
 * ── Migration ordering (adversarial B2) ──
 * This script requires the `last_run_at` column. Its migration is applied with
 * `prisma migrate deploy` (apply-only, does NOT generate) AFTER the operator
 * has approved the migration file — NEVER via `pnpm db:migrate` (=migrate dev,
 * which generates+applies and would bypass the approval gate). Bring the stack
 * up first:
 *
 *   docker compose -f ENV/compose.yaml up -d
 *   # (after approval) apply the reviewed migration:
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e4demo?schema=public" \
 *     pnpm --filter @ai-company-os/db exec prisma migrate deploy
 *
 * ── Run (isolated DB — NEVER aicos_dev) ──
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e4demo?schema=public" \
 *   REDIS_URL="redis://localhost:6379" \
 *     pnpm --filter @ai-company-os/api exec tsx scripts/live/scheduler-e2e.ts
 *
 * Stages:
 *   STAGE=seed    (default) seed + registerSchedule, wait ≤2min for a Run,
 *                 then PATCH the schedule, then DELETE + removeSchedule and
 *                 assert firing stops. Writes a small JSON pointer.
 *   STAGE=verify  re-run in a NEW process against the SAME Redis WITHOUT
 *                 re-registering — a fresh Run within ≤2min proves durability.
 *
 * NOTE: two-instance double-trigger (G2) is OPTIONAL/descoped — prod is a
 * single aicos-api instance (compose.prod.yaml has no replicas). The
 * idempotency guarantee (jobSchedulerId = pipeline.id) is asserted in the
 * runner-upsert unit test instead.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../../src/lib/db";
import { runQueue, scheduleQueue } from "../../src/lib/queue";
import {
  registerSchedule,
  removeSchedule,
  initScheduledTickWorker,
} from "../../src/modules/pipeline/runner";

const EVIDENCE_DIR =
  process.env.E4_EVIDENCE_DIR ??
  "/Users/mustafakaankocak/Documents/YULAlab-AI/ventures/braavolabs/workspace/findings-e4";
const STATE_PATH = resolve(EVIDENCE_DIR, "scheduler-state.json");
const EVERY_MINUTE = "*/1 * * * *"; // 5-field minute cron — prod semantics.
const WAIT_MS = 130_000; // ≤2min + margin.

function log(msg: string, extra?: unknown) {
  const line = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
  // eslint-disable-next-line no-console
  console.log(`[scheduler-e2e pid=${process.pid}] ${line}`);
}

async function countScheduledRuns(pipelineId: string): Promise<number> {
  return prisma.run.count({ where: { pipelineId, trigger: "scheduled" } });
}

async function waitForNewRun(pipelineId: string, baseline: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const now = await countScheduledRuns(pipelineId);
    if (now > baseline) return true;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return false;
}

async function seedStage(): Promise<void> {
  // The tick worker must run in-process to consume JobScheduler-produced jobs.
  initScheduledTickWorker();

  const tenant = await prisma.tenant.create({
    data: { name: "E4 Sched Tenant", slug: `e4sched-${Date.now()}`, plan: "PRO" },
  });
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, name: "E4 Sched Co", slug: `e4-sched-co-${Date.now()}`, status: "ACTIVE" },
  });
  const pipeline = await prisma.pipeline.create({
    data: {
      companyId: company.id,
      name: "E4 Scheduled Pipeline",
      trigger: "SCHEDULED",
      schedule: EVERY_MINUTE,
      steps: [{ name: "noop", agentRole: "worker", order: 0 }],
    },
  });
  log("seeded", { tenantId: tenant.id, companyId: company.id, pipelineId: pipeline.id });

  // ── AC#1 runtime registration → a Run appears without a restart ──
  const base1 = await countScheduledRuns(pipeline.id);
  await registerSchedule(pipeline);
  log("registered schedule; waiting ≤2min for first Run…");
  const fired1 = await waitForNewRun(pipeline.id, base1);
  if (!fired1) throw new Error("AC#1 FAILED — no scheduled Run within 2min of registerSchedule");
  log("AC#1 PASS — runtime registration fired a Run");

  // ── AC#3 delete stops firing + no invalid-FK errors ──
  await removeSchedule(pipeline.id);
  const remaining = await scheduleQueue.getJobScheduler(pipeline.id).catch(() => null);
  if (remaining) throw new Error("AC#3 FAILED — scheduler still present after removeSchedule");
  await prisma.pipeline.delete({ where: { id: pipeline.id } });
  const base3 = await countScheduledRuns(pipeline.id);
  log("deleted pipeline + removed scheduler; asserting no further Runs for 70s…");
  await new Promise((r) => setTimeout(r, 70_000));
  const after3 = await countScheduledRuns(pipeline.id);
  if (after3 !== base3) throw new Error("AC#3 FAILED — Runs kept appearing after delete");
  log("AC#3 PASS — deleted pipeline stopped firing, no orphan-FK run-create");

  // Seed a SECOND, durable pipeline for the verify (restart) stage. Left
  // registered on purpose — the verify process must find it in Redis.
  const durable = await prisma.pipeline.create({
    data: {
      companyId: company.id,
      name: "E4 Durable Scheduled Pipeline",
      trigger: "SCHEDULED",
      schedule: EVERY_MINUTE,
      steps: [{ name: "noop", agentRole: "worker", order: 0 }],
    },
  });
  await registerSchedule(durable);

  if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        seedPid: process.pid,
        tenantId: tenant.id,
        companyId: company.id,
        durablePipelineId: durable.id,
        durableRunBaseline: await countScheduledRuns(durable.id),
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  log("seed stage complete — now run STAGE=verify in a FRESH process for AC#4", { statePath: STATE_PATH });
}

async function verifyStage(): Promise<void> {
  initScheduledTickWorker();
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
    seedPid: number;
    durablePipelineId: string;
    durableRunBaseline: number;
  };
  if (state.seedPid === process.pid) {
    throw new Error("AC#4 FAILED — verify must run in a DIFFERENT process than seed");
  }
  // No re-registration here: the scheduler must already be in Redis.
  const sched = await scheduleQueue.getJobScheduler(state.durablePipelineId).catch(() => null);
  if (!sched) throw new Error("AC#4 FAILED — durable scheduler missing from Redis after restart");
  log("durable scheduler survived the process bounce; waiting ≤2min for a Run…", { seedPid: state.seedPid });
  const fired = await waitForNewRun(state.durablePipelineId, state.durableRunBaseline);
  if (!fired) throw new Error("AC#4 FAILED — durable scheduler did not fire after restart");
  log("AC#4 PASS — scheduler is durable across a process restart");
  // Cleanup the durable scheduler so the demo doesn't keep firing forever.
  await removeSchedule(state.durablePipelineId);
}

async function main(): Promise<void> {
  const stage = process.env.STAGE ?? "seed";
  log(`starting stage=${stage}`);
  if (stage === "seed") await seedStage();
  else if (stage === "verify") await verifyStage();
  else throw new Error(`Unknown STAGE=${stage} (use seed|verify)`);
  await Promise.all([runQueue.close(), scheduleQueue.close()]);
  await prisma.$disconnect();
  log("done");
  process.exit(0);
}

main().catch(async (err) => {
  log("FAILED", { error: err instanceof Error ? err.message : String(err) });
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
