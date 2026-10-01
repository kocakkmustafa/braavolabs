import type { Job } from "bullmq";
import { prisma } from "../../lib/db";
import { holdingRunQueue, createWorker } from "../../lib/queue";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { audit } from "./audit";
import { charterHash, lintCharter } from "./charter";
import { evaluatePolicy } from "./policy";
import { preflight } from "./cost-guard";
import { executeExtendedStep } from "./kinds";
import { notifySlack, type SlackProject } from "./slack";
import { sendApprovalRequest } from "./telegram";
import {
  STEP_KINDS,
  type HoldingCharter,
  type HoldingStepDef,
  type HoldingTrustLevelStr,
} from "./types";

/**
 * Durable run engine (FABLE_PLAN §3): a thin PG-backed layer ON TOP of the
 * existing BullMQ — never a second queue system. State of record lives in
 * `holding_workflow_runs` / `holding_step_runs`; Redis jobs are only the
 * "please execute" impulse and are idempotent per (runId, cursor).
 *
 * Crash/retry model: `resumeCursor` advances after EVERY completed step, so
 * a BullMQ retry (or a resume after approval) re-enters at the first
 * unfinished step and can never re-run a finished one.
 */

const QUEUE_NAME = "holding-runs";
const JOB_ATTEMPTS = 3;

export interface CreateRunInput {
  definitionKey: string;
  charter: HoldingCharter;
  input?: Record<string, unknown>;
  trustLevel: HoldingTrustLevelStr;
  /** Cost attribution target (venture slug or "holding") — required. */
  venture: string;
  trigger?: string;
}

export class HoldingRunRejected extends Error {
  constructor(public readonly reason: string) {
    super(`holding run rejected: ${reason}`);
  }
}

function parseStepDefs(raw: unknown): HoldingStepDef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HoldingRunRejected("definition has no steps");
  }
  return raw.map((entry, i) => {
    const step = entry as Partial<HoldingStepDef>;
    if (typeof step?.name !== "string" || step.name.length === 0) {
      throw new HoldingRunRejected(`step ${i}: missing name`);
    }
    if (!STEP_KINDS.includes(step.kind as never)) {
      throw new HoldingRunRejected(`step ${i} (${step.name}): unknown kind ${String(step.kind)}`);
    }
    if (typeof step.reasoning !== "string" || step.reasoning.trim().length === 0) {
      throw new HoldingRunRejected(`step ${i} (${step.name}): reasoning is mandatory`);
    }
    return {
      name: step.name,
      kind: step.kind as HoldingStepDef["kind"],
      reasoning: step.reasoning,
      params: (step.params ?? {}) as Record<string, unknown>,
    };
  });
}

/**
 * Gate chain at creation: K0 charter linter → policy → cost preflight.
 * Order matters — the cheapest deterministic gate runs first, and nothing
 * is persisted until every gate has passed (no half-created runs).
 */
export async function createHoldingRun(request: CreateRunInput) {
  // Function-level dormancy guard: the bootstrap flag alone is not enough
  // once other modules can import this function — dormant means NO new runs.
  if (!env.HOLDING_ENABLED) {
    throw new HoldingRunRejected("holding module is dormant (HOLDING_ENABLED != true)");
  }
  const definition = await prisma.holdingWorkflowDefinition.findUnique({
    where: { key: request.definitionKey },
  });
  if (!definition || !definition.enabled) {
    throw new HoldingRunRejected(`unknown or disabled definition ${request.definitionKey}`);
  }
  parseStepDefs(definition.steps);

  const lint = lintCharter(request.charter);
  if (!lint.ok) {
    throw new HoldingRunRejected(`charter K0 lint failed: ${lint.errors.join("; ")}`);
  }
  if (request.charter.riskClass !== definition.riskClass) {
    throw new HoldingRunRejected(
      `charter riskClass ${request.charter.riskClass} != definition riskClass ${definition.riskClass}`,
    );
  }
  if (typeof request.venture !== "string" || request.venture.trim().length === 0) {
    throw new HoldingRunRejected("venture attribution is required (tag'siz run reddedilir)");
  }

  const policy = evaluatePolicy({
    riskClass: definition.riskClass as never,
    trustLevel: request.trustLevel,
    autonomyLevel: definition.autonomyLevel,
  });
  if (policy.decision === "DENY") {
    await audit({
      actor: "holding.runner",
      action: "holding.run_denied",
      entity: "holding_workflow_definition",
      entityId: definition.id,
      payload: { reason: policy.reason, trustLevel: request.trustLevel },
    });
    throw new HoldingRunRejected(policy.reason);
  }

  const cost = await preflight(request.charter.estCostUsd ?? 0);
  if (!cost.ok) {
    await audit({
      actor: "holding.runner",
      action: "holding.run_cost_blocked",
      entity: "holding_workflow_definition",
      entityId: definition.id,
      payload: { reason: cost.reason },
    });
    throw new HoldingRunRejected(cost.reason ?? "cost guard blocked");
  }

  const run = await prisma.holdingWorkflowRun.create({
    data: {
      definitionId: definition.id,
      status: policy.decision === "REQUIRE_APPROVAL" ? "WAITING_APPROVAL" : "PENDING",
      charter: request.charter as unknown as object,
      charterHash: charterHash(request.charter),
      trustLevel: request.trustLevel,
      riskClass: definition.riskClass,
      venture: request.venture,
      trigger: request.trigger ?? "manual",
      input: (request.input ?? {}) as object,
    },
  });
  await audit({
    actor: "holding.runner",
    action: "holding.run_created",
    entity: "holding_workflow_run",
    entityId: run.id,
    runId: run.id,
    payload: {
      definitionKey: definition.key,
      policy: policy.decision,
      reason: policy.reason,
      softAlert: cost.softAlert ?? false,
    },
  });

  if (policy.decision === "REQUIRE_APPROVAL") {
    const approval = await prisma.holdingApproval.create({
      data: {
        runId: run.id,
        riskClass: definition.riskClass,
        description: `[${definition.riskClass}] ${definition.name}: ${request.charter.goal}`,
      },
    });
    await audit({
      actor: "holding.runner",
      action: "holding.approval_requested",
      entity: "holding_approval",
      entityId: approval.id,
      runId: run.id,
      payload: { reason: policy.reason },
    });
    const messageId = await sendApprovalRequest({
      id: approval.id,
      description: `${definition.name}\n${request.charter.goal}`,
      riskClass: definition.riskClass,
    }).catch((err) => {
      logger.error({ err, approvalId: approval.id }, "approval Telegram send failed — DB queue still holds it");
      return null;
    });
    if (messageId) {
      await prisma.holdingApproval.update({
        where: { id: approval.id },
        data: { telegramMessageId: messageId },
      });
    }
    return run;
  }

  await enqueueHoldingRun(run.id, 0);
  return run;
}

// NOT exported on purpose: createHoldingRun is the single policy choke-point
// (K0 → policy → cost guard). Direct enqueue would bypass all three gates.
async function enqueueHoldingRun(runId: string, cursor: number): Promise<void> {
  await holdingRunQueue.add(
    "execute-holding-run",
    { runId },
    {
      // Idempotency: one Redis job per (run, cursor) — a double resume or a
      // duplicated webhook can never double-execute a step window.
      //
      // ⚠️ Separator is "__", NOT ":" — BullMQ rejects custom job ids that
      // contain ":" ("Custom Ids cannot contain :") because ":" is its own
      // Redis key separator. With ":" this add() threw on EVERY run, so no
      // workflow could ever be enqueued. The unit tests missed it: they swap
      // the queue for an in-memory double that does not enforce BullMQ's id
      // rules, so the defect only surfaced against real Redis.
      jobId: `${runId}__${cursor}`,
      attempts: JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

export async function processHoldingRun(job: Job<{ runId: string }>): Promise<void> {
  const { runId } = job.data;
  const run = await prisma.holdingWorkflowRun.findUnique({
    where: { id: runId },
    include: { definition: true },
  });
  if (!run) {
    logger.warn({ runId }, "holding run vanished — dropping job");
    return;
  }
  // Stale-job guard: only PENDING/RUNNING may execute. A run parked in
  // WAITING_APPROVAL resumes via a NEW job from resolveHoldingApproval.
  if (run.status !== "PENDING" && run.status !== "RUNNING") {
    logger.info({ runId, status: run.status }, "holding job ignored (terminal or paused run)");
    return;
  }

  const steps = parseStepDefs(run.definition.steps);
  // `startedAt` boşsa bu run'ın İLK yürütmesindeyiz. Bir run birden çok kez
  // yürütülür: onay kapısında park edip devam ettiğinde ve motor yeniden
  // başladığında yetim-kurtarma yeniden kuyruğa aldığında.
  const isFirstExecution = run.startedAt == null;
  await prisma.holdingWorkflowRun.update({
    where: { id: runId },
    data: { status: "RUNNING", startedAt: run.startedAt ?? new Date() },
  });

  // Slack raporlaması (D5, kurucu kararı 2026-08-07): "anlamlı olaylar".
  // Workflow başlangıcı/bitişi anlamlıdır, tekil adımlar değil — bu ayrım
  // bilinçlidir, yoksa kanal günde yüzlerce mesajla okunamaz hale gelir.
  //
  // ⚠️ `isFirstExecution` kapısı şart: bu blok koşulsuz çalıştığında tek bir
  // workflow "başladı" bildirimini her devam edişte ve her motor yeniden
  // başlatmasında tekrar yolluyordu (ölçüm: 2 run → 11 started olayı).
  // Gürültüyü önleme amacı tam da burada kaybediliyordu.
  if (isFirstExecution) {
    void notifySlack({
      kind: "workflow.started",
      project: slackProjectOf(run),
      title: `${run.definition.name} başladı`,
      fields: { adım: steps.length, risk: run.riskClass },
      runId,
    });
  }

  let lastOutput: Record<string, unknown> = {};
  for (let i = run.resumeCursor ?? 0; i < steps.length; i++) {
    const step = steps[i];
    const stepRun = await prisma.holdingStepRun.create({
      data: {
        runId,
        stepIndex: i,
        name: step.name,
        reasoning: step.reasoning,
        status: "RUNNING",
        input: (step.params ?? {}) as object,
        startedAt: new Date(),
      },
    });

    try {
      if (step.kind === "approval") {
        const approval = await prisma.holdingApproval.create({
          data: {
            runId,
            stepIndex: i,
            riskClass: run.riskClass,
            description: String(step.params?.description ?? `${run.definition.name} → ${step.name}`),
          },
        });
        await prisma.holdingStepRun.update({
          where: { id: stepRun.id },
          data: { status: "SUCCEEDED", output: { approvalId: approval.id }, finishedAt: new Date() },
        });
        // Park AFTER this step: resume continues at i+1 on approval.
        await prisma.holdingWorkflowRun.update({
          where: { id: runId },
          data: { status: "WAITING_APPROVAL", resumeCursor: i + 1 },
        });
        await audit({
          actor: "holding.runner",
          action: "holding.run_paused_for_approval",
          entity: "holding_approval",
          entityId: approval.id,
          runId,
          payload: { stepIndex: i, stepName: step.name },
        });
        const messageId = await sendApprovalRequest({
          id: approval.id,
          description: String(step.params?.description ?? `${run.definition.name} → ${step.name}`),
          riskClass: run.riskClass,
        }).catch(() => null);
        if (messageId) {
          await prisma.holdingApproval.update({
            where: { id: approval.id },
            data: { telegramMessageId: messageId },
          });
        }
        return;
      }

      // CONSTRAINT for future step kinds: any kind that spends real money
      // (LLM/API calls) MUST call cost-guard recordSpend() with the actual
      // amount — without it the spend-rate freeze (>$2/5dk) is blind.
      // (D4 kinds are deterministic/$0; the pipeline kind's product-side
      // spend is metered by the PRODUCT's own usage_meters.)
      if (step.kind === "log") {
        logger.info({ runId, step: step.name, params: step.params }, "holding log step");
        lastOutput = { logged: true, ...step.params };
      } else if (
        step.kind === "pipeline" ||
        step.kind === "patrol" ||
        step.kind === "classify" ||
        // D5 (2026-08-07): publish/report da deterministik ve $0 —
        // sosyal platform API'leri ücretsiz, Slack webhook'u ücretsiz.
        // Yukarıdaki cost-guard şartı bu yüzden tetiklenmiyor.
        step.kind === "publish" ||
        step.kind === "report"
      ) {
        // ⚠️ Önceki adımın çıktısı İLERİ TAŞINIR (`oncekiAdim`). Eskiden yalnız
        // `run.input` geçiliyordu; `lastOutput` hesaplanıp kullanılmıyordu.
        // Sonucu ölçüldü: `gunluk-brief` hattı SUCCEEDED döndü ama modele
        // özetleyecek hiçbir veri ulaşmadı ("verilen veri eksik" yanıtı).
        // Boru hattı bağlıydı, içinden su akmıyordu.
        lastOutput = await executeExtendedStep(step, {
          ...((run.input ?? {}) as Record<string, unknown>),
          oncekiAdim: lastOutput,
        });
      } else {
        lastOutput = {};
      }

      await prisma.holdingStepRun.update({
        where: { id: stepRun.id },
        data: { status: "SUCCEEDED", output: lastOutput as object, finishedAt: new Date() },
      });
      await prisma.holdingWorkflowRun.update({
        where: { id: runId },
        data: { resumeCursor: i + 1 },
      });
      await audit({
        actor: "holding.runner",
        action: "holding.step_completed",
        entity: "holding_step_run",
        entityId: stepRun.id,
        runId,
        payload: { stepIndex: i, stepName: step.name, kind: step.kind },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.holdingStepRun.update({
        where: { id: stepRun.id },
        data: { status: "FAILED", error: message, finishedAt: new Date() },
      });
      const attemptsExhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (attemptsExhausted) {
        await prisma.holdingWorkflowRun.update({
          where: { id: runId },
          data: { status: "FAILED", error: message, finishedAt: new Date() },
        });
        void notifySlack({
          kind: "workflow.failed",
          project: slackProjectOf(run),
          title: `${run.definition.name} BAŞARISIZ — ${step.name}`,
          fields: { hata: message.slice(0, 280), adım: step.name },
          severity: "SEV2",
          runId,
        });
      }
      await audit({
        actor: "holding.runner",
        action: attemptsExhausted ? "holding.run_failed" : "holding.step_retry_pending",
        entity: "holding_step_run",
        entityId: stepRun.id,
        runId,
        payload: { stepIndex: i, error: message, attempt: job.attemptsMade + 1 },
      });
      throw err;
    }
  }

  await prisma.holdingWorkflowRun.update({
    where: { id: runId },
    data: { status: "SUCCEEDED", output: lastOutput as object, finishedAt: new Date() },
  });
  await audit({
    actor: "holding.runner",
    action: "holding.run_succeeded",
    entity: "holding_workflow_run",
    entityId: runId,
    runId,
  });
  void notifySlack({
    kind: "workflow.completed",
    project: slackProjectOf(run),
    title: `${run.definition.name} tamamlandı`,
    fields: { adım: steps.length },
    runId,
  });
}

/**
 * Bir run'ı Slack projesine eşle. Workflow adı bir marka içeriyorsa o markanın
 * kanalına, içermiyorsa holding kanalına düşer — hiçbir olay sessizce kaybolmaz.
 */
function slackProjectOf(run: { definition: { name: string } }): SlackProject {
  const name = run.definition.name.toLowerCase();
  if (name.includes("braavo")) return "braavolabs";
  if (name.includes("burun")) return "burunfarki";
  if (name.includes("lifeos")) return "lifeos";
  if (name.includes("yulalab") || name.includes("yula lab")) return "yulalab";
  return "holding";
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
}

export async function resolveHoldingApproval(input: ApprovalDecisionInput): Promise<{ ok: boolean; reason?: string }> {
  const approval = await prisma.holdingApproval.findUnique({ where: { id: input.approvalId } });
  if (!approval) return { ok: false, reason: "approval not found" };

  // ATOMIC claim: the status condition lives in the WHERE clause, so two
  // concurrent deciders can never both win — count 0 means someone else's
  // decision landed first (TOCTOU guard; first decision wins, rest audited).
  const claimed = await prisma.holdingApproval.updateMany({
    where: { id: input.approvalId, status: "PENDING" },
    data: { status: input.decision, decidedBy: input.decidedBy, decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    await audit({
      actor: input.decidedBy,
      action: "holding.approval_replay_ignored",
      entity: "holding_approval",
      entityId: approval.id,
      runId: approval.runId ?? undefined,
    });
    return { ok: false, reason: "already decided" };
  }

  await audit({
    actor: input.decidedBy,
    action: `holding.approval_${input.decision.toLowerCase()}`,
    entity: "holding_approval",
    entityId: approval.id,
    runId: approval.runId ?? undefined,
  });

  if (!approval.runId) return { ok: true };

  if (input.decision === "APPROVED") {
    // Same atomic pattern on the run: only a WAITING_APPROVAL run may resume.
    const resumed = await prisma.holdingWorkflowRun.updateMany({
      where: { id: approval.runId, status: "WAITING_APPROVAL" },
      data: { status: "PENDING" },
    });
    if (resumed.count === 0) {
      return { ok: true, reason: "run not waiting — nothing to resume" };
    }
    const run = await prisma.holdingWorkflowRun.findUnique({ where: { id: approval.runId } });
    await enqueueHoldingRun(approval.runId, run?.resumeCursor ?? 0);
  } else {
    const cancelled = await prisma.holdingWorkflowRun.updateMany({
      where: { id: approval.runId, status: "WAITING_APPROVAL" },
      data: { status: "CANCELLED", error: `approval ${approval.id} rejected`, finishedAt: new Date() },
    });
    if (cancelled.count > 0) {
      await audit({
        actor: input.decidedBy,
        action: "holding.run_cancelled",
        entity: "holding_workflow_run",
        entityId: approval.runId,
        runId: approval.runId,
      });
    }
  }
  return { ok: true };
}

/**
 * Boot reconciliation (orphan guard): a crash between the DB write and the
 * Redis enqueue leaves a PENDING/RUNNING run with no job. Re-enqueueing is
 * safe because jobIds are (runId, cursor)-idempotent — a live or completed
 * job with the same id simply wins.
 */
export async function reconcileOrphanHoldingRuns(): Promise<number> {
  const orphans = await prisma.holdingWorkflowRun.findMany({
    where: { status: { in: ["PENDING", "RUNNING"] } },
  });
  for (const run of orphans) {
    await enqueueHoldingRun(run.id, run.resumeCursor ?? 0);
    logger.warn({ runId: run.id, status: run.status }, "re-enqueued possibly-orphaned holding run");
  }
  return orphans.length;
}

export function initHoldingWorker() {
  return createWorker<{ runId: string }>(QUEUE_NAME, processHoldingRun, { concurrency: 1 });
}
