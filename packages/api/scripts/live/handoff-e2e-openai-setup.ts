/**
 * LIVE E3 handoff demo — OpenAI NATIVE-TOOL "from" leg (MOCK=0).
 *
 * Companion to handoff-e2e-setup.ts, but the FROM leg is a REAL OpenAI call
 * that emits NATIVE tool_calls (get_time) — proving the "from" leg is a
 * genuine tool-using provider, not a prompt-fallback. The tool-call turn +
 * its tool result are seeded into the canonical transcript that the
 * turn-boundary interrupt FREEZES into the ledger checkpoint. A separate
 * process (handoff-e2e-resume.ts) then reads only the ledger and resumes the
 * task on OLLAMA — the tool-using OpenAI context carried across the provider
 * boundary via the E2 normalize/projection layer.
 *
 * Also exercises the D-015 fix: because a REAL multi-message transcript is
 * frozen, the ledger.contextSummary must come out NON-empty (derived from
 * checkpoint.messages), not "No prior context captured.".
 *
 * Key from env ONLY (never hardcoded, never logged):
 *   OPENAI_API_KEY=sk-... DATABASE_URL="...aicos_e3demo..." \
 *     pnpm --filter api exec tsx scripts/live/handoff-e2e-openai-setup.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prisma } from "../../src/lib/db";
import {
  chatCompletion,
  type AIClientConfig,
  type ChatMessage,
  type ChatToolDef,
} from "../../src/services/ai-client";
import {
  runProviderAgentLoop,
  HandoffInterrupt,
  type ProviderAgentLoopConfig,
} from "../../src/modules/agent/claude";
import { createHandoff } from "../../src/modules/run/handoff.service";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_MODEL = "gemma3:4b";
const OPENAI_MODEL = "gpt-4o-mini";
const EVIDENCE_DIR =
  process.env.E3_EVIDENCE_DIR ??
  "/Users/mustafakaankocak/Documents/YULAlab-AI/braavolabs-v2-workspace/findings-e3";
const STATE_PATH = resolve(EVIDENCE_DIR, "handoff-state.json");

const TIME_TOOL: ChatToolDef = {
  name: "get_time",
  description:
    "Returns the current time for an IANA timezone. Always call this instead of guessing the time.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "IANA timezone, e.g. Europe/Istanbul" },
    },
    required: ["timezone"],
  },
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
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY must be set in the environment (never hardcoded).");
  }
  const FROM_CONFIG: AIClientConfig = {
    provider: "OPENAI",
    model: OPENAI_MODEL,
    apiKey: openaiKey,
  };

  const PID = process.pid;
  log("SETUP PROCESS (OpenAI native-tool FROM leg)", {
    pid: PID,
    dbUrl,
    fromProvider: "OPENAI",
    fromModel: OPENAI_MODEL,
    toProvider: "OLLAMA",
    toModel: OLLAMA_MODEL,
    keyPresent: openaiKey.length > 0,
  });

  // ── 1. Seed tenant / company / pipeline / agent + two provider links ──────
  const tenant = await prisma.tenant.create({
    data: { name: "E3 OpenAI Demo Tenant", slug: `e3openai-${Date.now()}`, plan: "PRO" },
  });
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, name: "E3 OpenAI Demo Co", slug: "e3-openai-demo-co", status: "ACTIVE" },
  });
  const agent = await prisma.agent.create({
    data: {
      companyId: company.id,
      name: "Handoff OpenAI Demo Agent",
      role: "handoff_demo",
      systemPrompt:
        "You are a precise assistant. Use the provided tools when relevant instead of guessing.",
      tools: [],
      model: OPENAI_MODEL,
      maxTokens: 512,
      autonomy: "AUTONOMOUS",
    },
  });
  const pipeline = await prisma.pipeline.create({
    data: {
      companyId: company.id,
      name: "E3 OpenAI Handoff Pipeline",
      pipelineType: "SEQUENTIAL",
      steps: [{ name: "handoff-step", agentRole: "handoff_demo", order: 0 }],
    },
  });
  // FROM = OPENAI (default), TO = OLLAMA (fallback, keyless local).
  await prisma.userAIConfig.create({
    data: {
      tenantId: tenant.id,
      provider: "OLLAMA",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
      isDefault: false,
      fallbackOrder: 1,
    },
  });
  log("SEEDED", {
    tenantId: tenant.id,
    providerLinks: ["OPENAI(from, via config)", "OLLAMA(fallback, keyless local)"],
  });

  // ── 2. Run + step (RUNNING) ───────────────────────────────────────────────
  const run = await prisma.run.create({
    data: {
      pipelineId: pipeline.id,
      status: "RUNNING",
      trigger: "e3-openai-handoff-demo",
      input: { task: "Tell me the current time in Istanbul, then summarize." },
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
  log("RUN + STEP", { runId: run.id, runStepId: runStep.id });

  // ── 3a. REAL OpenAI NATIVE tool-call turn (the "from" leg proof) ──────────
  const system = agent.systemPrompt;
  const priorUser: ChatMessage = {
    role: "user",
    content: "What time is it in Istanbul right now? Use the get_time tool.",
  };
  const t1 = await chatCompletion(FROM_CONFIG, system, [priorUser], 256, { tools: [TIME_TOOL] });
  const toolCalls = (t1 as any).toolCalls ?? [];
  log("REAL OPENAI — FROM leg turn 1 (NATIVE tool_calls)", {
    model: t1.model,
    provider: t1.provider,
    stopReason: (t1 as any).stopReason,
    toolUseMode: (t1 as any).toolUseMode,
    toolCalls,
    tokens: { in: t1.inputTokens, out: t1.outputTokens },
  });
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error("FROM leg proof failed: OpenAI did not emit native tool_calls.");
  }

  // Execute the tool locally (real value) and build the genuine tool-using
  // transcript: [user, assistant(tool_calls), tool(result)].
  const tz = (() => {
    try {
      return JSON.parse(toolCalls[0].argumentsJson ?? "{}").timezone ?? "Europe/Istanbul";
    } catch {
      return "Europe/Istanbul";
    }
  })();
  const toolResult = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(1751534400000)); // fixed instant → deterministic, still real formatting
  const assistantToolMsg: ChatMessage = {
    role: "assistant",
    content: t1.content ?? "",
    toolCalls: toolCalls as any,
  } as any;
  const toolResultMsg: ChatMessage = {
    role: "tool",
    content: `The time in ${tz} is ${toolResult}.`,
    toolCallId: toolCalls[0].id,
  } as any;
  const seededContext: ChatMessage[] = [priorUser, assistantToolMsg, toolResultMsg];
  log("SEEDED TOOL-USING TRANSCRIPT", {
    length: seededContext.length,
    roles: seededContext.map((m) => m.role),
    toolTimezone: tz,
    toolResult,
  });

  // ── 3b. Manual handoff on the RUNNING run (checkpoint pending) ─────────────
  const ledger = await createHandoff({
    runId: run.id,
    reason: "MANUAL",
    createdBy: "e3-openai-operator",
    fromProvider: "OPENAI",
    fromModel: OPENAI_MODEL,
  });
  await prisma.run.update({ where: { id: run.id }, data: { status: "PAUSED" } });
  log("HANDOFF OPENED (checkpoint pending)", {
    handoffId: ledger.id,
    checkpointNull: ledger.checkpoint === null,
    contextSummaryAtOpen: ledger.contextSummary,
  });

  // ── 3c. Live loop → turn-boundary interrupt freezes the tool-using checkpoint
  const loopConfig: ProviderAgentLoopConfig = {
    systemPrompt: system,
    userMessage: "Continue: give a one-line summary using the time you fetched.",
    toolNames: [],
    model: OPENAI_MODEL,
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
    log("UNEXPECTED", "loop completed without interrupt");
  } catch (err) {
    if (err instanceof HandoffInterrupt) {
      interrupted = true;
      log("HANDOFF INTERRUPT (graceful, turn-boundary)", { message: err.message });
    } else {
      throw err;
    }
  }
  if (!interrupted) throw new Error("FROM leg did not interrupt at a turn boundary");

  // ── 4. Read back the frozen ledger (D-015: contextSummary must be non-empty)
  const frozen = await prisma.handoffLedger.findUnique({ where: { id: ledger.id } });
  const cp = (frozen?.checkpoint ?? null) as { messages?: ChatMessage[] } | null;
  const hasToolMsg = (cp?.messages ?? []).some(
    (m: any) => m.role === "tool" || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0),
  );
  log("LEDGER AFTER FREEZE", {
    id: frozen?.id,
    status: frozen?.status,
    fromProvider: frozen?.fromProvider,
    checkpointFrozen: cp !== null,
    "checkpoint.messages.length": cp?.messages?.length ?? 0,
    checkpointCarriesToolContext: hasToolMsg,
    contextSummary: frozen?.contextSummary,
    D015_summaryNonEmpty: frozen?.contextSummary !== "No prior context captured." && !!frozen?.contextSummary,
  });

  // ── 5. Pointer for resume + evidence ──────────────────────────────────────
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        variant: "openai-native-from",
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
        toModel: OLLAMA_MODEL,
        baseUrl: OLLAMA_BASE_URL,
      },
      null,
      2,
    ),
  );
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    resolve(EVIDENCE_DIR, "06-openai-from-setup.json"),
    JSON.stringify(
      {
        setupPid: PID,
        fromLeg: {
          provider: t1.provider,
          model: t1.model,
          stopReason: (t1 as any).stopReason,
          toolUseMode: (t1 as any).toolUseMode,
          toolCalls,
          tokens: { in: t1.inputTokens, out: t1.outputTokens },
        },
        seededTranscriptRoles: seededContext.map((m) => m.role),
        ledger: frozen,
        checkpointCarriesToolContext: hasToolMsg,
      },
      null,
      2,
    ),
  );
  log("SETUP DONE — PROCESS EXITS (in-memory dies)", {
    setupPid: PID,
    handoffId: ledger.id,
    contextSummary: frozen?.contextSummary,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n=== OPENAI SETUP FAILED ===");
    console.error(err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
