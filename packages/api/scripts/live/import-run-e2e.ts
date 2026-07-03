/**
 * LIVE E5/T3 import→run acceptance — MOCK=0, REAL Postgres + REAL Redis + a
 * REAL (local, keyless) LLM.
 *
 * Proves acceptance criterion #1b (plan-e5): an automation imported through the
 * FAZ-1 importer produces a pipeline that ACTUALLY RUNS — the executor no longer
 * throws "no agent" / "workspace has no agents yet", and at least one RunStep
 * finalizes COMPLETED (not an empty silent-COMPLETED run).
 *
 * What it exercises end to end (per fixture: n8n + generic + mcp):
 *   1. Convert the fixture with the SAME adapter + agent-synthesis code the
 *      HTTP importer uses (finalizeSteps → deriveAgentsFromSteps).
 *   2. Persist: create the fixed-2-role Agents (findFirst→create) + a Pipeline
 *      whose `steps` column carries the executor-shaped step list — the exact
 *      T1 persist contract.
 *   3. Assert Pipeline.steps is non-empty AND the company has the synthesized
 *      Agents AND every step.agentRole exact-matches an Agent role.
 *   4. Enqueue a Run through the real BullMQ worker (initPipelineRunner +
 *      enqueueRun) and wait for it to leave PENDING/RUNNING.
 *   5. Assert the executor did NOT throw a "no agent" error and that at least
 *      one RunStep row reached COMPLETED.
 *
 * ── LLM precondition (BLOCKER — operator-machine only) ──
 * Each step runs a REAL `runAgentLoop` = a REAL LLM call. There is NO stub/fake
 * provider in ai-client.ts. The only keyless path is a LOCAL provider
 * (OLLAMA / LMSTUDIO / CUSTOM). This harness therefore:
 *   • sets the seed tenant's default UserAIConfig to OLLAMA (keyless), and
 *   • OVERRIDES every synthesized Agent.model to a local model (the synthesized
 *     default `claude-sonnet-4-*` cannot run on Ollama).
 * Run `ollama serve` and `ollama pull <model>` first. This script is NOT part of
 * the vitest unit suite (lives outside src/) and is NOT run in CI.
 *
 * ── Setup (isolated DB — NEVER aicos_dev) ──
 *   docker compose -f ENV/compose.yaml up -d
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e5import?schema=public" \
 *     pnpm --filter @ai-company-os/db exec prisma migrate deploy   # after approval
 *   ollama serve &        # keyless local LLM
 *   ollama pull qwen2.5:7b
 *
 * ── Run ──
 *   DATABASE_URL="postgresql://aicos:aicos_dev@localhost:5432/aicos_e5import?schema=public" \
 *   REDIS_URL="redis://localhost:6379" \
 *   OLLAMA_MODEL="qwen2.5:7b" \
 *   OLLAMA_BASE_URL="http://localhost:11434/v1" \
 *     pnpm --filter @ai-company-os/api exec tsx scripts/live/import-run-e2e.ts
 *
 * Exit code 0 = every fixture imported → ran → ≥1 RunStep COMPLETED, no "no
 * agent" error. 1 = any assertion failed (kizil today: pre-T1, steps=[] → 0
 * RunSteps → fail).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../../src/lib/db";
import { runQueue } from "../../src/lib/queue";
import { initPipelineRunner, enqueueRun } from "../../src/modules/pipeline/runner";
import { saveTenantAIConfig } from "../../src/services/ai-client";
import {
  deriveAgentsFromSteps,
  IMPORTED_LLM_ROLE,
  IMPORTED_OPERATOR_ROLE,
} from "../../src/modules/automation-importer/agent-synthesis";
import { fromN8n } from "../../src/modules/automation-importer/adapters/n8n";
import { fromGeneric } from "../../src/modules/automation-importer/adapters/generic";
import { fromMcp } from "../../src/modules/automation-importer/adapters/mcp";
import type { ConvertedPipeline } from "../../src/modules/automation-importer/adapters/types";

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const WAIT_MS = 180_000; // local models can be slow on first load.

function log(msg: string, extra?: unknown) {
  const line = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
  // eslint-disable-next-line no-console
  console.log(`[import-run-e2e pid=${process.pid}] ${line}`);
}

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), "utf8");
}

const CONVERTERS: Record<string, (payload: string) => ConvertedPipeline> = {
  n8n: fromN8n,
  generic: fromGeneric,
  mcp: fromMcp,
};

interface Seeded {
  tenantId: string;
  companyId: string;
}

async function seedTenant(label: string): Promise<Seeded> {
  const tenant = await prisma.tenant.create({
    data: { name: `E5 Import ${label}`, slug: `e5import-${label}-${Date.now()}`, plan: "PRO" },
  });
  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: `E5 Import Co ${label}`,
      slug: `e5-import-co-${label}-${Date.now()}`,
      status: "ACTIVE",
    },
  });
  // Point the tenant at a keyless LOCAL provider so runAgentLoop can execute
  // without an API key. baseUrl → local Ollama OpenAI-compatible endpoint.
  await saveTenantAIConfig(tenant.id, "OLLAMA", OLLAMA_MODEL, "", OLLAMA_BASE_URL);
  return { tenantId: tenant.id, companyId: company.id };
}

/** Mirror the T1 importer persist path (adapters → synthesize → persist). */
async function importFixture(
  companyId: string,
  source: string,
  payload: string,
): Promise<{ pipelineId: string; stepCount: number; agentCount: number }> {
  const converter = CONVERTERS[source];
  if (!converter) throw new Error(`No converter for ${source}`);
  const result = converter(payload);
  const { agents: agentSpecs } = deriveAgentsFromSteps(result.pipeline.steps);

  const pipeline = await prisma.$transaction(async (tx) => {
    for (const spec of agentSpecs) {
      const existing = await tx.agent.findFirst({ where: { companyId, role: spec.role } });
      if (!existing) {
        await tx.agent.create({
          data: {
            companyId,
            name: spec.name,
            role: spec.role,
            systemPrompt: spec.systemPrompt,
            // T3 LLM precondition: local model override (synthesized default is
            // claude-sonnet-4-*, which Ollama can't serve).
            model: OLLAMA_MODEL,
          },
        });
      }
    }
    return tx.pipeline.create({
      data: {
        companyId,
        name: result.pipeline.name,
        trigger: "MANUAL",
        steps: result.pipeline.steps as any,
        config: { importedFrom: source } as any,
      },
    });
  });

  return {
    pipelineId: pipeline.id,
    stepCount: result.pipeline.steps.length,
    agentCount: agentSpecs.length,
  };
}

async function assertMaterialized(pipelineId: string, companyId: string): Promise<void> {
  const pipeline = await prisma.pipeline.findUniqueOrThrow({ where: { id: pipelineId } });
  const steps = pipeline.steps as Array<{ agentRole: string; order: number; name: string }>;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`FAIL — Pipeline.steps is empty (${pipelineId})`);
  }
  const agents = await prisma.agent.findMany({ where: { companyId } });
  if (agents.length === 0) throw new Error(`FAIL — company ${companyId} has no agents`);
  const agentRoles = new Set(agents.map((a) => a.role));
  for (const s of steps) {
    if (!agentRoles.has(s.agentRole)) {
      throw new Error(`FAIL — step.agentRole "${s.agentRole}" has no exact-match Agent`);
    }
  }
  const roles = [...agentRoles].filter((r) => r === IMPORTED_LLM_ROLE || r === IMPORTED_OPERATOR_ROLE);
  log("materialized OK", { steps: steps.length, agents: agents.length, importedRoles: roles });
}

async function runAndAssert(pipelineId: string, tenantId: string): Promise<void> {
  const run = await prisma.run.create({
    data: { pipelineId, status: "PENDING", trigger: "manual", input: {} },
  });
  await enqueueRun(run.id);
  log("enqueued run; waiting for terminal state…", { runId: run.id });

  const deadline = Date.now() + WAIT_MS;
  let status = run.status;
  while (Date.now() < deadline) {
    const cur = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    status = cur.status;
    if (status !== "PENDING" && status !== "RUNNING") break;
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const steps = await prisma.runStep.findMany({ where: { runId: run.id } });
  const completed = steps.filter((s) => s.status === "COMPLETED");
  const failedNoAgent = steps.some(
    (s) => typeof s.error === "string" && /no agent|no agents yet/i.test(s.error),
  );
  const runRow = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
  const runNoAgent = typeof runRow.error === "string" && /no agent|no agents yet/i.test(runRow.error);

  log("run finished", {
    status,
    runSteps: steps.length,
    completed: completed.length,
    runError: runRow.error ?? null,
  });

  if (runNoAgent || failedNoAgent) {
    throw new Error(`FAIL — executor threw a "no agent" error (${runRow.error ?? "step-level"})`);
  }
  if (completed.length === 0) {
    throw new Error(`FAIL — no RunStep reached COMPLETED (silent-empty run?)`);
  }
}

async function main(): Promise<void> {
  initPipelineRunner(); // in-process worker consumes the enqueued run.

  const cases: Array<{ source: string; fixture: string }> = [
    { source: "n8n", fixture: "n8n-sample.json" },
    { source: "generic", fixture: "generic-sample.json" },
    { source: "mcp", fixture: "mcp-sample.json" },
  ];

  for (const c of cases) {
    log(`── ${c.source} (${c.fixture}) ──`);
    const seeded = await seedTenant(c.source);
    const payload = loadFixture(c.fixture);
    const imported = await importFixture(seeded.companyId, c.source, payload);
    log("imported", imported);
    await assertMaterialized(imported.pipelineId, seeded.companyId);
    await runAndAssert(imported.pipelineId, seeded.tenantId);
    log(`✓ ${c.source} PASS`);
  }

  await runQueue.close();
  await prisma.$disconnect();
  log("ALL FIXTURES PASSED");
  process.exit(0);
}

main().catch(async (err) => {
  log("FAILED", { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  try {
    await runQueue.close();
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
