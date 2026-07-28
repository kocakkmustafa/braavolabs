import { prisma } from "../../lib/db";
import { enqueueRun } from "../pipeline/runner";
import { ensureYulaTenant } from "./tenant";
import { classifyMail, type InboundMail } from "./sensors";
import { suggestAdvisor } from "./reference";
import type { HoldingStepDef } from "./types";

/**
 * D4 extended step kinds — the dogfood bridge (KK-2026-07-27).
 *
 * `pipeline` runs a PRODUCT pipeline inside the YULA_INTERNAL tenant, so a
 * holding step becomes real product traffic (visible on desktop/mobile/CLI,
 * governed by the product's own approvals/steering). `patrol`/`classify`
 * are deterministic in D4 — their LLM chains (sınıf-1: local Qwen → free
 * API → Haiku) attach when the founder's BYOK keys land (K3); until then
 * anything the tables can't answer ESCALATES instead of guessing (DNA 7).
 */

const PIPELINE_WAIT_MS = 5 * 60_000;
const PIPELINE_POLL_MS = 5_000;
const TERMINAL_RUN_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

export class ExtendedStepError extends Error {}

export interface ExtendedStepOpts {
  /** Test hook — overrides the poll interval. */
  pollMs?: number;
  now?: () => number;
}

export async function executeExtendedStep(
  step: HoldingStepDef,
  runInput: Record<string, unknown>,
  opts: ExtendedStepOpts = {},
): Promise<Record<string, unknown>> {
  switch (step.kind) {
    case "classify":
      return executeClassify(step, runInput);
    case "patrol":
      return executePatrol(step);
    case "pipeline":
      return executePipeline(step, opts);
    default:
      throw new ExtendedStepError(`extended kind değil: ${step.kind}`);
  }
}

async function executeClassify(step: HoldingStepDef, runInput: Record<string, unknown>) {
  const mode = String(step.params?.mode ?? "mail");
  if (mode === "mail") {
    const mail = (step.params?.mail ?? runInput.mail) as InboundMail | undefined;
    if (!mail?.from || typeof mail.subject !== "string") {
      throw new ExtendedStepError("classify(mail): girdi şeması eksik ({from, subject} zorunlu)");
    }
    const signal = classifyMail(mail);
    // Escalation enrichment: the small model doesn't think — it attaches the
    // catalog's advisor suggestion for the founder session (ENTEGRASYON §1).
    const advisor = signal.severity === "SEV1" ? suggestAdvisor(`${signal.kind} store ret policy`) : null;
    return { signal, onerilen_danisman: advisor?.id ?? null };
  }
  // Tabloda olmayan mod = tahmin yok, eskalasyon (run FAILED → bildirim).
  throw new ExtendedStepError(`classify: '${mode}' modu tanımsız — ESKALE (LLM zinciri K3 sonrası)`);
}

async function executePatrol(step: HoldingStepDef) {
  const scope = String(step.params?.scope ?? "sentinel-summary");
  if (scope !== "sentinel-summary") {
    throw new ExtendedStepError(`patrol: '${scope}' kapsamı tanımsız — ESKALE`);
  }
  const events = await prisma.holdingSentinelEvent.findMany({
    where: { status: "NEW" },
    take: 200,
    orderBy: { createdAt: "asc" },
  });
  const summary: Record<string, number> = {};
  for (const event of events) {
    const bucket = `${event.severity}:${event.kind}`;
    summary[bucket] = (summary[bucket] ?? 0) + 1;
  }
  if (events.length > 0) {
    // NEW→CLASSIFIED only. Severity is NEVER touched here — S1 hiçbir S0
    // sinyalini bastıramaz; özetleme bastırma değildir, olaylar durur.
    await prisma.holdingSentinelEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { status: "CLASSIFIED" },
    });
  }
  return { scanned: events.length, summary };
}

async function executePipeline(step: HoldingStepDef, opts: ExtendedStepOpts) {
  const pipelineKey = String(step.params?.pipelineKey ?? "");
  if (!pipelineKey) throw new ExtendedStepError("pipeline: params.pipelineKey zorunlu");

  const tenant = await ensureYulaTenant();
  const pipeline = await prisma.pipeline.findFirst({
    where: { name: pipelineKey, company: { tenantId: tenant.id } },
  });
  if (!pipeline) {
    throw new ExtendedStepError(
      `YULA tenant'ında '${pipelineKey}' pipeline'ı yok — D5 yüzey turunda oluşturulacak`,
    );
  }

  const productRun = await prisma.run.create({
    data: {
      pipelineId: pipeline.id,
      trigger: "holding",
      input: (step.params?.input ?? {}) as object,
    },
  });
  await enqueueRun(productRun.id);

  // Bounded wait: the holding step reports the product run's fate but never
  // hangs the worker — on timeout/product-approval the surfaces own it.
  const pollMs = opts.pollMs ?? PIPELINE_POLL_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + PIPELINE_WAIT_MS;
  while (now() < deadline) {
    const current = await prisma.run.findUnique({ where: { id: productRun.id } });
    if (!current) break;
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(current.status)) {
      return { productRunId: productRun.id, status: current.status, output: current.output ?? null };
    }
    if (current.status === "WAITING_APPROVAL") {
      return {
        productRunId: productRun.id,
        status: current.status,
        note: "ürün onay bekliyor — takip ürün yüzeylerinde (dogfood)",
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { productRunId: productRun.id, status: "TIMEOUT", note: "5dk içinde bitmedi — takip ürün yüzeylerinde" };
}
