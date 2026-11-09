/**
 * BRA-P0-03d — adım-düzeyi onay kapısı (ADR-0003 "03d notu").
 *
 * Pipeline/plan-kartı adımının `config.needsApproval === true` ya da
 * `config.risk === "high"` ayarı YÜRÜTÜCÜDE zorlanır: adım çalışmadan önce bir
 * onay satırı oluşturulur, koşu WAITING_APPROVAL'a geçer ve adım onay olmadan
 * çalışmaz — araç meta'sından ve ajan autonomy'sinden (AUTONOMOUS dahil)
 * BAĞIMSIZ. Onay, exact-action kalıbıyla (kiracı + koşu + eylem hash'i + nonce
 * + süre) bağlı TEK KULLANIMLIK haktır; tüketilince aynı adım yeniden
 * çalıştırılırsa (retry / resume sonrası yeniden deneme) yeni onay ister.
 *
 * STEP_APPROVAL_GATE (varsayılan KAPALI, yalnız literal "true", çağrı anında
 * okunur — JOB_STATE_DUAL_WRITE / EXACT_ACTION_APPROVAL ile aynı kalıp). Kapalıyken
 * `requireStepApproval` hiçbir şey okumaz/yazmaz: davranış birebir eskisi.
 * Bu modülün import'ta yan etkisi yoktur. Migration gerektirmez: Approval
 * tablosunun mevcut (type=SPEND, metadata.gate="step") alanları kullanılır.
 *
 * Tek çekirdek nokta: `executeStep` (sıralı + paralel runner, /resume ve /continue
 * ile yeniden kuyruğa alma, retry, /steps/:id/rerun hepsi buradan geçer).
 */
import { createHash } from "node:crypto";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { notifyTenantUsers } from "../../services/push";
import { transitionRun } from "../run/transition";
import {
  buildApprovalStamp,
  canonicalize,
  computeActionHash,
  consumeGrant,
  type ExactAction,
} from "../approval/exact-action";

/** Yalnız literal "true" kapıyı açar. */
export function isStepApprovalGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STEP_APPROVAL_GATE === "true";
}

/** Açıkça "hayır" sayılan değerler; bunun dışındaki her şey (belirsiz tip dahil) fail-closed gated. */
function isExplicitlyOff(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0) return true;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "" || t === "false";
  }
  return false;
}

/**
 * Adım yüksek riskli mi? FAIL-CLOSED: pipeline şeması `config`i `unknown` kabul eder, bu yüzden
 * `needsApproval` için true/1/"true"/"TRUE"/"1"/"yes" gibi truthy-benzeri ya da yorumlanamayan
 * her değer gated sayılır (yalnız undefined/null/false/0/""/"false" gated değildir). `risk`
 * büyük/küçük harf ve boşluk duyarsız "high" ya da string olmayan belirsiz değerse gated.
 * config nesne değilse (null/undefined hariç) gated.
 */
export function stepRequiresApproval(config: unknown): boolean {
  if (config === undefined || config === null) return false;
  if (typeof config !== "object" || Array.isArray(config)) return true;
  const c = config as Record<string, unknown>;
  if (!isExplicitlyOff(c.needsApproval)) return true;
  const r = c.risk;
  if (r === undefined || r === null) return false;
  if (typeof r !== "string") return true;
  return r.trim().toLowerCase() === "high";
}

export interface StepGateInput {
  tenantId: string;
  runId: string;
  stepIndex: number;
  stepName: string;
  agentRole: string;
  config?: Record<string, unknown> | null;
}

export type StepGateResult =
  | { proceed: true; gated: boolean }
  /** Onay bekleniyor (satır var/yeni, koşu WAITING_APPROVAL): adım ÇALIŞMAZ. */
  | { proceed: false; reason: "awaiting_approval"; approvalId: string }
  /** Kapı güvenle kurulamadı (koşu artık aktif değil / eylem bağlanamadı): adım ÇALIŞMAZ. */
  | { proceed: false; reason: "gate_unavailable"; message: string };

/** Adımın normalize (sıralı anahtar) config özeti: sha256, sır içermez. Düzenleme (TOCTOU) onayı geçersiz kılar. */
function configDigest(config: unknown): string {
  return createHash("sha256").update(canonicalize(config === undefined ? null : config)).digest("hex");
}

function buildAction(i: StepGateInput): ExactAction {
  const c = (i.config ?? {}) as Record<string, unknown>;
  return {
    tenantId: i.tenantId,
    runId: i.runId,
    type: "STEP",
    toolName: `step:${i.stepIndex}:${i.stepName}`,
    // previousOutput bilerek hash'e girmez: yeniden denemede değişir ve onayı geçersiz kılardı.
    // agentRole + config özeti girer: onaydan sonra adım düzenlenirse onay geçmez.
    input: {
      gate: "step",
      stepIndex: i.stepIndex,
      name: i.stepName,
      agentRole: i.agentRole,
      tool: typeof c.tool === "string" ? c.tool : null,
      risk: typeof c.risk === "string" ? c.risk : null,
      configDigest: configDigest(i.config ?? null),
    },
    amountUsd: null,
  };
}

/**
 * Adım çalışmadan ÖNCE çağrılır. Kapı kapalıysa ya da adım yüksek riskli değilse
 * `{proceed:true, gated:false}`. Aksi halde geçerli bir onay hakkı atomik tüketilirse
 * `{proceed:true, gated:true}`; tüketilemezse onay satırı oluşturulur/yeniden
 * kullanılır, koşu WAITING_APPROVAL'a geçirilir ve `proceed:false` döner.
 */
export async function requireStepApproval(input: StepGateInput): Promise<StepGateResult> {
  if (!isStepApprovalGateEnabled() || !stepRequiresApproval(input.config)) {
    return { proceed: true, gated: false };
  }

  let action: ExactAction;
  let actionHash: string;
  try {
    action = buildAction(input);
    actionHash = computeActionHash(action);
  } catch (err) {
    logger.error({ runId: input.runId, err: (err as Error).message }, "Step gate: action cannot be bound — blocking");
    return { proceed: false, reason: "gate_unavailable", message: `Step "${input.stepName}" cannot be bound to an approval` };
  }

  const grant = await consumeGrant(prisma, { tenantId: input.tenantId, runId: input.runId, actionHash });
  if (grant.ok) {
    await prisma.activityLog.create({
      data: {
        tenantId: input.tenantId,
        actor: "system",
        action: "approval.consumed",
        resource: "approval",
        resourceId: grant.approvalId,
        details: { gate: "step", runId: input.runId, step: input.stepName, stepIndex: input.stepIndex } as never,
      },
    });
    logger.info({ runId: input.runId, step: input.stepName, approvalId: grant.approvalId }, "Step gate: grant consumed — step may run");
    return { proceed: true, gated: true };
  }

  // Zaten bekleyen aynı eylem onayı varsa yenisini açma (yeniden kuyruğa alma çift satır üretmesin).
  const existing = await prisma.approval.findFirst({
    where: { runId: input.runId, tenantId: input.tenantId, actionHash, status: "PENDING" },
    select: { id: true },
  });
  let approvalId: string;
  if (existing) {
    approvalId = existing.id;
  } else {
    const c = (input.config ?? {}) as Record<string, unknown>;
    const approval = await prisma.approval.create({
      data: {
        runId: input.runId,
        type: "SPEND",
        description: `Step needs your approval: ${input.stepName}`,
        amountUsd: null as never,
        metadata: {
          gate: "step",
          stepIndex: input.stepIndex,
          stepName: input.stepName,
          agentRole: input.agentRole,
          tool: typeof c.tool === "string" ? c.tool : null,
          risk: typeof c.risk === "string" ? c.risk : null,
          needsApproval: !isExplicitlyOff(c.needsApproval),
        } as never,
        status: "PENDING",
        ...buildApprovalStamp(action),
      },
    });
    approvalId = approval.id;
  }

  const o = await transitionRun(prisma, input.runId, "NEEDS_APPROVAL", {
    tenantId: input.tenantId,
    legacyUnchecked: true,
    // Yarış koruması: /stop /pause ile kapı arasında CANCELLED/PAUSED, WAITING_APPROVAL ile ezilmesin.
    onlyIfStatus: ["RUNNING"],
  });
  let waiting = o.ok;
  if (!waiting) {
    // Kardeş (paralel) adım koşuyu zaten WAITING_APPROVAL'a almış olabilir.
    const cur = await prisma.run.findUnique({ where: { id: input.runId }, select: { status: true } });
    waiting = cur?.status === "WAITING_APPROVAL";
  }
  if (!waiting) {
    logger.warn({ runId: input.runId, approvalId, reason: o.ok ? null : o.reason }, "Step gate: run could not enter WAITING_APPROVAL — approval withdrawn");
    if (!existing) {
      await prisma.approval
        .deleteMany({ where: { id: approvalId, status: "PENDING" } })
        .catch((err) => logger.warn({ approvalId, err: (err as Error).message }, "Step gate: withdrawing approval failed"));
    }
    return { proceed: false, reason: "gate_unavailable", message: "Run is no longer active; step approval was not requested" };
  }

  if (!existing) {
    await prisma.activityLog.create({
      data: {
        tenantId: input.tenantId,
        actor: "system",
        action: "approval.requested",
        resource: "run_step",
        details: { gate: "step", approvalId, runId: input.runId, step: input.stepName, stepIndex: input.stepIndex } as never,
      },
    });
    notifyTenantUsers(input.tenantId, "approval", {
      title: "Approval needed",
      body: `Step "${input.stepName}" is waiting for your decision`,
      data: { kind: "approval", id: approvalId },
    }).catch(() => {});
  }
  logger.info({ runId: input.runId, step: input.stepName, approvalId }, "Step gate: step requires approval — paused");
  return { proceed: false, reason: "awaiting_approval", approvalId };
}

/** Hiyerarşik/başka yürütücü adım yapılandırmasını zorlayamıyorsa fail-closed için: kapı açık + gated adım var mı. */
export function pipelineHasGatedSteps(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => s && typeof s === "object" && stepRequiresApproval((s as { config?: Record<string, unknown> }).config));
}

export type StepIdentity<T extends { name: string; order?: number }> =
  | { ok: true; step: T & { order: number } }
  | { ok: false; reason: "no_match" };

/**
 * Bir RunStep'in pipeline adımını KESİN kimlikle bulur: runner'ın `allSteps` dizisiyle
 * (eksik `order` → dizi indeksi, `order`a göre kararlı sıralama) AYNI yoldan `stepIndex`
 * konumundaki adım, ve adı RunStep adıyla birebir eşleşmeli. Gevşek ad-veya-sıra
 * eşleşmesi kapıyı başka adımın config'iyle atlatabildiği için rerun bunu kullanır.
 */
export function resolveStepByIdentity<T extends { name: string; order?: number }>(
  steps: unknown,
  stepIndex: number,
  stepName: string,
): StepIdentity<T> {
  if (!Array.isArray(steps)) return { ok: false, reason: "no_match" };
  const all = (steps as T[]).map((s, idx) => ({ ...s, order: s.order ?? idx })).sort((a, b) => a.order - b.order);
  const cand = all[stepIndex];
  if (!cand || cand.name !== stepName) return { ok: false, reason: "no_match" };
  return { ok: true, step: cand };
}
