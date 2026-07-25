/**
 * LIVE E3/T9 handoff demo — RESUME + CLAIM leg (MOCK=0).
 *
 * The SECOND of two SEPARATE OS processes (see handoff-e2e-setup.ts). This is a
 * FRESH tsx invocation — a DIFFERENT PID — that has NO in-memory link to the
 * setup process: E2's circuits/pendingLinks Maps are empty here. It proves the
 * takeover survives process death (B1) by reconstructing everything from the DB
 * alone:
 *
 *   1. read the OPEN handoff ledger from the DB (the ONLY carrier),
 *   2. claim it for to=OLLAMA (keyless local /v1) via claimHandoff — flips
 *      OPEN→CLAIMED, records toProvider/toModel + the takeover baseUrl,
 *   3. re-enqueue the run to RUNNING and drive executeStep, which detects the
 *      CLAIMED ledger for this run+stepIndex (resolveStepTakeover), resolves the
 *      takeover config, and resumes the loop from the FROZEN checkpoint on REAL
 *      Ollama (resumeMessages + handoff note),
 *   4. the step COMPLETES → executor flips the ledger COMPLETED → run COMPLETED.
 *
 * Prints THIS process's PID (different from setup's) and the final COMPLETED
 * ledger dump. gemma3 is toolless (prompt-fallback) — honest footnote in the
 * evidence pack.
 *
 * Usage (isolated DB — NEVER aicos_dev):
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e3demo?schema=public" \
 *     pnpm --filter api exec tsx scripts/live/handoff-e2e-resume.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../../src/lib/db";
import type { ChatMessage } from "../../src/services/ai-client";
import { claimHandoff } from "../../src/modules/run/handoff.service";
import { executeStep, type StepDef } from "../../src/modules/pipeline/executor";

const EVIDENCE_DIR =
  process.env.E3_EVIDENCE_DIR ??
  "/Users/mustafakaankocak/Documents/YULAlab-AI/ventures/braavolabs/workspace/findings-e3";
const STATE_PATH = resolve(EVIDENCE_DIR, "handoff-state.json");

function log(section: string, obj: unknown): void {
  console.log(`\n=== ${section} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/aicos_e3demo/.test(dbUrl)) {
    throw new Error(
      `REFUSING to run: DATABASE_URL must target the isolated aicos_e3demo DB, got "${dbUrl}".`,
    );
  }
  const PID = process.pid;

  // ── 0. State pointer written by the SETUP process (DB + this tiny file are
  // the ONLY things that crossed the process boundary — no in-memory carrier).
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
    setupPid: number;
    runId: string;
    runStepId: string;
    handoffId: string;
    tenantId: string;
    toProvider: string;
    toModel: string;
    baseUrl: string;
  };
  log("RESUME PROCESS", {
    resumePid: PID,
    setupPid: state.setupPid,
    differentProcess: PID !== state.setupPid,
    dbUrl,
    handoffId: state.handoffId,
  });

  // ── 1. Read the OPEN ledger from the DB — the ONLY carrier ─────────────────
  const before = await prisma.handoffLedger.findUnique({ where: { id: state.handoffId } });
  if (!before) throw new Error(`ledger ${state.handoffId} not found in DB`);
  const cpBefore = (before.checkpoint ?? null) as { messages?: ChatMessage[] } | null;
  log("LEDGER READ FROM DB (pre-claim)", {
    id: before.id,
    status: before.status,
    fromProvider: before.fromProvider,
    toProvider: before.toProvider,
    "checkpoint.messages.length": cpBefore?.messages?.length ?? 0,
  });
  if (before.status !== "OPEN") {
    throw new Error(`expected OPEN ledger, got ${before.status}`);
  }

  // ── 2. Claim it for to=OLLAMA (keyless local, baseUrl from setup) ──────────
  const claimed = await claimHandoff({
    handoffId: state.handoffId,
    provider: "OLLAMA",
    model: state.toModel,
    baseUrl: state.baseUrl, // keyless-local baseUrl (§2.5/B4c)
    claimedBy: "e3-demo-resume",
  });
  log("LEDGER CLAIMED (OPEN → CLAIMED)", {
    id: claimed.id,
    status: claimed.status,
    fromProvider: claimed.fromProvider,
    toProvider: claimed.toProvider,
    toModel: claimed.toModel,
  });

  // ── 3. Re-enqueue the run: RUNNING, then drive executeStep (takeover path) ─
  // Mirrors the /continue endpoint's enqueueRun — but we drive executeStep
  // directly so the demo is a single deterministic process (no BullMQ worker
  // needed). resolveStepTakeover inside executeStep finds THIS CLAIMED ledger,
  // resolves the OLLAMA config, and seeds runAgentLoop with the frozen
  // checkpoint messages + the handoff note → REAL Ollama continues the task.
  await prisma.run.update({ where: { id: state.runId }, data: { status: "RUNNING" } });

  const run = await prisma.run.findUnique({
    where: { id: state.runId },
    select: { input: true },
  });
  const stepDef: StepDef = { name: "handoff-step", agentRole: "handoff_demo", order: 0 };

  log("EXECUTING TAKEOVER STEP (REAL Ollama, to=OLLAMA)", {
    runId: state.runId,
    stepIndex: 0,
    resumePid: PID,
  });
  const result = await executeStep(state.runId, stepDef, 0, run?.input ?? {}, new Map());

  log("TAKEOVER STEP RESULT (REAL Ollama output)", {
    stepId: result.stepId,
    status: result.status,
    output: result.output,
    reasoning: result.reasoning?.slice(0, 400),
    costUsd: result.costUsd,
  });

  // ── 4. Finalize the run COMPLETED (the runner would; we do it explicitly) ──
  if (result.status === "COMPLETED") {
    await prisma.run.update({
      where: { id: state.runId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  } else {
    await prisma.run.update({ where: { id: state.runId }, data: { status: "FAILED" } });
    throw new Error(`takeover step did not COMPLETE (status=${result.status})`);
  }

  // ── 5. Read the final COMPLETED ledger + the new takeover RunStep row ──────
  const finalLedger = await prisma.handoffLedger.findUnique({ where: { id: state.handoffId } });
  const cpFinal = (finalLedger?.checkpoint ?? null) as
    | { messages?: ChatMessage[]; toolUseMode?: string; turn?: number; claimBaseUrl?: string }
    | null;

  // The takeover opened a NEW RunStep row (B6.5) tagged with the ledger id.
  const takeoverStep = await prisma.runStep.findUnique({
    where: { id: result.stepId },
    select: { id: true, stepIndex: true, status: true, output: true },
  });
  const runFinal = await prisma.run.findUnique({
    where: { id: state.runId },
    select: { status: true },
  });

  log("FINAL LEDGER (CLAIMED → COMPLETED)", {
    id: finalLedger?.id,
    status: finalLedger?.status,
    fromProvider: finalLedger?.fromProvider,
    toProvider: finalLedger?.toProvider,
    toModel: finalLedger?.toModel,
    "checkpoint.messages.length": cpFinal?.messages?.length ?? 0,
    "checkpoint.toolUseMode": cpFinal?.toolUseMode,
    "checkpoint.claimBaseUrl": cpFinal?.claimBaseUrl,
    completedAt: finalLedger?.completedAt,
  });
  log("RUN FINAL STATUS", { runId: state.runId, status: runFinal?.status });

  // ── 6. Evidence pack: two PIDs, ledger dump, activity log, real output ─────
  const activity = await prisma.activityLog.findMany({
    where: {
      tenantId: state.tenantId,
      action: { in: ["run.handoff_created", "run.handoff_claimed"] },
    },
    orderBy: { createdAt: "asc" },
    select: { action: true, actor: true, resourceId: true, details: true, createdAt: true },
  });

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidence = {
    demo: "E3 T9 — cross-process, cross-provider handoff (MOCK=0)",
    capturedAt: new Date().toISOString(),
    processProof: {
      setupPid: state.setupPid,
      resumePid: PID,
      differentProcesses: state.setupPid !== PID,
      note:
        "Two different PIDs with NO in-memory carrier between them — the ledger " +
        "was reconstructed from the DB alone. This is the durable/cross-session proof (B1).",
    },
    ledger: {
      id: finalLedger?.id,
      fromProvider: finalLedger?.fromProvider,
      toProvider: finalLedger?.toProvider,
      fromModel: finalLedger?.fromModel,
      toModel: finalLedger?.toModel,
      reason: finalLedger?.reason,
      status: finalLedger?.status,
      "checkpoint.messages.length": cpFinal?.messages?.length ?? 0,
      "checkpoint.toolUseMode": cpFinal?.toolUseMode,
      contextSummary: finalLedger?.contextSummary,
      createdAt: finalLedger?.createdAt,
      claimedAt: finalLedger?.claimedAt,
      completedAt: finalLedger?.completedAt,
    },
    checkpointMessages: cpFinal?.messages ?? [],
    activityLog: activity,
    takeoverStep,
    runFinalStatus: runFinal?.status,
    realOllamaTakeoverOutput: result.output,
    toolUseMode: cpFinal?.toolUseMode ?? "prompt-fallback",
    honestFootnote:
      "gemma3:4b has NO native tool support (TOOL_INCAPABLE_MODEL_PREFIXES) → both legs " +
      "run TOOLLESS / prompt-fallback. from=CUSTOM and to=OLLAMA are DIFFERENT AIProvider " +
      "enum values (real cross-provider ledger transition) both dialing the SAME local " +
      "Ollama /v1 — keyless, free, MOCK=0. A native-tooled from-leg (tool_calls rows) would " +
      "additionally run ANTHROPIC→OPENAI if the operator supplies a real cloud key.",
  };
  writeFileSync(resolve(EVIDENCE_DIR, "03-resume-completed-evidence.json"), JSON.stringify(evidence, null, 2));

  log("EVIDENCE WRITTEN", {
    resumePid: PID,
    file: resolve(EVIDENCE_DIR, "03-resume-completed-evidence.json"),
    ledgerStatus: finalLedger?.status,
    runStatus: runFinal?.status,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n=== RESUME FAILED ===");
    console.error(err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
