/**
 * LIVE E3/T9 handoff demo — SETUP + INTERRUPT leg (MOCK=0).
 *
 * Proves the CROSS-PROCESS, cross-provider takeover of the handoff protocol
 * with a REAL database (aicos_e3demo) and a REAL Ollama (gemma3:4b). This
 * script is the FIRST of two SEPARATE OS processes:
 *
 *   1. handoff-e2e-setup.ts  (THIS FILE) — seeds a tenant/company/pipeline/
 *      agent + two provider links (from=CUSTOM, to=OLLAMA, both keyless local
 *      /v1), runs the FROM leg on the REAL loop against REAL Ollama, then
 *      interrupts it at a TURN BOUNDARY (checkTurnBoundaryInterrupt) so the
 *      OPEN handoff ledger's checkpoint is FROZEN and a HandoffInterrupt is
 *      thrown — exactly the §2.3a-2 path. Prints this PID + the ledger.id, then
 *      the process DIES (in-memory circuits/pendingLinks are gone).
 *
 *   2. handoff-e2e-resume.ts (FRESH tsx invocation = a DIFFERENT OS process) —
 *      reads ONLY the ledger from the DB, claims it (to=OLLAMA), and runs the
 *      takeover leg on the REAL loop against REAL Ollama, resuming from the
 *      frozen checkpoint. Prints its own (DIFFERENT) PID.
 *
 * Two different PIDs + a ledger that goes OPEN→CLAIMED→COMPLETED with NO
 * in-memory carrier between them = the "durable / cross-session" proof (B1).
 *
 * KEYLESS cross-provider (no cloud key needed): from=CUSTOM and to=OLLAMA are
 * DIFFERENT AIProvider enum values (real cross-provider handoff mechanics) that
 * both dial the SAME local Ollama /v1. gemma3 has NO native tool support
 * (TOOL_INCAPABLE_MODEL_PREFIXES) → the loop runs toolless / prompt-fallback.
 * The native-tooled "from" leg would additionally run if the operator supplies
 * a real cloud key — see the honest footnote in the evidence pack.
 *
 * Usage (isolated DB — NEVER aicos_dev):
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e3demo?schema=public" \
 *     pnpm --filter api exec tsx scripts/live/handoff-e2e-setup.ts
 *
 * State handed to the resume process lives in DB + a small JSON pointer written
 * to findings-e3/handoff-state.json (runId, handoffId, tenantId, baseUrl,model).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prisma } from "../../src/lib/db";
import {
  chatCompletion,
  type AIClientConfig,
  type ChatMessage,
} from "../../src/services/ai-client";
import {
  runProviderAgentLoop,
  HandoffInterrupt,
  type ProviderAgentLoopConfig,
} from "../../src/modules/agent/claude";
import { createHandoff } from "../../src/modules/run/handoff.service";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const MODEL = "gemma3:4b";
// Evidence lands in the workspace (E3_EVIDENCE_DIR override), NOT the worktree.
const EVIDENCE_DIR =
  process.env.E3_EVIDENCE_DIR ??
  "/Users/mustafakaankocak/Documents/YULAlab-AI/braavolabs-v2-workspace/findings-e3";
const STATE_PATH = resolve(EVIDENCE_DIR, "handoff-state.json");

/** The FROM provider config: CUSTOM enum, keyless, pointed at local Ollama. A
 * DIFFERENT enum value from the takeover (OLLAMA) so the ledger records a real
 * cross-provider transition; both dial the same free local endpoint. */
const FROM_CONFIG: AIClientConfig = {
  provider: "CUSTOM",
  model: MODEL,
  apiKey: "",
  baseUrl: OLLAMA_BASE_URL,
};

function log(section: string, obj: unknown): void {
  console.log(`\n=== ${section} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/aicos_e3demo/.test(dbUrl)) {
    throw new Error(
      `REFUSING to run: DATABASE_URL must target the isolated aicos_e3demo DB, got "${dbUrl}". ` +
        `aicos_dev must never be touched.`,
    );
  }
  const PID = process.pid;
  log("SETUP PROCESS", { pid: PID, dbUrl, model: MODEL, fromProvider: "CUSTOM", toProvider: "OLLAMA" });

  // ── 1. Seed tenant / company / pipeline / agent + two provider links ──────
  const tenant = await prisma.tenant.create({
    data: { name: "E3 Demo Tenant", slug: `e3demo-${Date.now()}`, plan: "PRO" },
  });
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, name: "E3 Demo Co", slug: "e3-demo-co", status: "ACTIVE" },
  });
  const agent = await prisma.agent.create({
    data: {
      companyId: company.id,
      name: "Handoff Demo Agent",
      role: "handoff_demo",
      systemPrompt:
        "You are a concise assistant completing a short multi-part task. " +
        "Answer directly in plain text.",
      tools: [],
      model: MODEL,
      maxTokens: 512,
      autonomy: "AUTONOMOUS",
    },
  });
  const pipeline = await prisma.pipeline.create({
    data: {
      companyId: company.id,
      name: "E3 Handoff Pipeline",
      pipelineType: "SEQUENTIAL",
      steps: [{ name: "handoff-step", agentRole: "handoff_demo", order: 0 }],
    },
  });

  // Two BYOK links: CUSTOM (default, the FROM leg) + OLLAMA (fallback, the TO
  // leg). Both keyless local — encryptedApiKey NULL, baseUrl set. This is what
  // resolveViableHandoffTarget / listTenantProviderLinks read.
  await prisma.userAIConfig.create({
    data: {
      tenantId: tenant.id,
      provider: "CUSTOM",
      model: MODEL,
      baseUrl: OLLAMA_BASE_URL,
      isDefault: true,
      fallbackOrder: 0,
    },
  });
  await prisma.userAIConfig.create({
    data: {
      tenantId: tenant.id,
      provider: "OLLAMA",
      model: MODEL,
      baseUrl: OLLAMA_BASE_URL,
      isDefault: false,
      fallbackOrder: 1,
    },
  });
  log("SEEDED", {
    tenantId: tenant.id,
    companyId: company.id,
    pipelineId: pipeline.id,
    agentId: agent.id,
    providerLinks: ["CUSTOM(default,keyless)", "OLLAMA(fallback,keyless)"],
  });

  // ── 2. Create the run + run step (RUNNING) ────────────────────────────────
  const run = await prisma.run.create({
    data: {
      pipelineId: pipeline.id,
      status: "RUNNING",
      trigger: "e3-handoff-demo",
      input: { task: "Introduce yourself, then wait to continue." },
      budgetUsd: "1.000000",
      startedAt: new Date(),
    },
  });
  const runStep = await prisma.runStep.create({
    data: {
      runId: run.id,
      agentId: agent.id,
      stepIndex: 0,
      name: "handoff-step",
      status: "RUNNING",
      reasoning: "",
      input: run.input as any,
      startedAt: new Date(),
    },
  });
  log("RUN + STEP", { runId: run.id, runStepId: runStep.id, stepIndex: 0, status: "RUNNING" });

  // ── 3a. REAL Ollama turn (FROM=CUSTOM) — genuine multi-message transcript ──
  // A real prior exchange the FROM provider produced. This is the canonical
  // transcript the interrupt will freeze into the ledger checkpoint — NOT
  // fabricated: every assistant message below is a live gemma3 completion.
  const system = agent.systemPrompt;
  const priorUser: ChatMessage = {
    role: "user",
    content:
      "Part 1 of 2: In one short sentence, state that you are the FROM provider " +
      "(CUSTOM/gemma3) starting this task. Then say you will pause for a handoff.",
  };
  const t1 = await chatCompletion(FROM_CONFIG, system, [priorUser], 256);
  log("REAL OLLAMA — FROM leg turn 1 (CUSTOM)", {
    model: t1.model,
    provider: t1.provider,
    content: t1.content,
    tokens: { in: t1.inputTokens, out: t1.outputTokens },
  });

  // Build the genuine canonical transcript so far: [user, assistant]. Seed it
  // as the loop's `context` so buildCheckpoint() at the turn-0 boundary freezes
  // a REAL >=3-message transcript into the ledger.
  const priorAssistant: ChatMessage = { role: "assistant", content: t1.content };
  const seededContext: ChatMessage[] = [priorUser, priorAssistant];

  // ── 3b. Open the OPEN ledger (checkpoint=null) + PAUSE the run ─────────────
  // This is the MANUAL handoff trigger on a RUNNING run (§2.3a-1 / T5 endpoint
  // path): the ledger opens with checkpoint=NULL and the LIVE loop is the single
  // writer that freezes it at the next turn boundary. We set PAUSED so the
  // turn-boundary check trips.
  const ledger = await createHandoff({
    runId: run.id,
    reason: "MANUAL",
    createdBy: "e3-demo-operator",
    fromProvider: "CUSTOM",
    fromModel: MODEL,
    // RUNNING run + no freeze flag → checkpoint stays NULL for the live loop.
  });
  await prisma.run.update({ where: { id: run.id }, data: { status: "PAUSED" } });
  log("HANDOFF OPENED (checkpoint pending)", {
    handoffId: ledger.id,
    status: ledger.status,
    checkpointNull: ledger.checkpoint === null,
    fromProvider: ledger.fromProvider,
    runPaused: true,
  });

  // ── 3c. Run the REAL loop → turn-boundary interrupt freezes the checkpoint ─
  // The loop starts, hits checkTurnBoundaryInterrupt at turn 0: it sees the
  // OPEN ledger, persists the live checkpoint to run_steps.transcript, FREEZES
  // the ledger.checkpoint from buildCheckpoint() (= the seeded real transcript),
  // and throws HandoffInterrupt. NO fake data — the freeze is the loop's own.
  const loopConfig: ProviderAgentLoopConfig = {
    systemPrompt: system,
    userMessage:
      "Part 2 of 2: continue the task from where Part 1 left off.",
    toolNames: [],
    model: MODEL,
    maxTokens: 256,
    budgetUsd: 1.0,
    context: seededContext as any,
    govContext: {
      tenantId: tenant.id,
      companyId: company.id,
      runId: run.id,
      runStepId: runStep.id,
      autonomy: "AUTONOMOUS",
    },
  };

  let interrupted = false;
  try {
    await runProviderAgentLoop(loopConfig, FROM_CONFIG);
    log("UNEXPECTED", "loop completed without interrupt — the OPEN ledger was not seen");
  } catch (err) {
    if (err instanceof HandoffInterrupt) {
      interrupted = true;
      log("HANDOFF INTERRUPT (graceful, turn-boundary)", {
        name: err.name,
        message: err.message,
        runId: err.runId,
        runStatus: err.runStatus,
        handoffLedgerId: err.handoffLedgerId,
      });
    } else {
      throw err;
    }
  }
  if (!interrupted) {
    throw new Error("FROM leg did not interrupt at a turn boundary — demo precondition failed");
  }

  // ── 4. Read back the FROZEN ledger checkpoint (proof it's real) ────────────
  const frozen = await prisma.handoffLedger.findUnique({ where: { id: ledger.id } });
  const cp = (frozen?.checkpoint ?? null) as { messages?: ChatMessage[]; turn?: number } | null;
  log("LEDGER AFTER FREEZE", {
    id: frozen?.id,
    status: frozen?.status,
    fromProvider: frozen?.fromProvider,
    toProvider: frozen?.toProvider,
    checkpointFrozen: cp !== null,
    "checkpoint.messages.length": cp?.messages?.length ?? 0,
    contextSummary: frozen?.contextSummary,
  });

  // Also read the live run_steps.transcript (crash carrier).
  const stepAfter = await prisma.runStep.findUnique({
    where: { id: runStep.id },
    select: { status: true, transcript: true },
  });
  log("RUN STEP AFTER INTERRUPT", {
    status: stepAfter?.status,
    transcriptPresent: stepAfter?.transcript !== null,
  });

  // ── 5. Persist a small pointer for the RESUME process + evidence files ─────
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const state = {
    createdAt: new Date().toISOString(),
    setupPid: PID,
    dbUrl,
    tenantId: tenant.id,
    companyId: company.id,
    pipelineId: pipeline.id,
    agentId: agent.id,
    runId: run.id,
    runStepId: runStep.id,
    handoffId: ledger.id,
    toProvider: "OLLAMA",
    toModel: MODEL,
    baseUrl: OLLAMA_BASE_URL,
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  // Ledger dump (frozen, OPEN) for the evidence pack.
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    resolve(EVIDENCE_DIR, "01-setup-ledger-open.json"),
    JSON.stringify(
      {
        setupPid: PID,
        ledger: frozen,
        realOllamaFromTurn: {
          model: t1.model,
          provider: t1.provider,
          content: t1.content,
          tokens: { in: t1.inputTokens, out: t1.outputTokens },
        },
        stepAfterInterrupt: stepAfter,
      },
      null,
      2,
    ),
  );

  log("SETUP DONE — PROCESS WILL EXIT (in-memory state dies here)", {
    setupPid: PID,
    handoffId: ledger.id,
    ledgerStatus: frozen?.status,
    nextStep: "run handoff-e2e-resume.ts in a SEPARATE process",
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n=== SETUP FAILED ===");
    console.error(err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
