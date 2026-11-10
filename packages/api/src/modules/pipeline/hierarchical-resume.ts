/**
 * BRA-P0-04j — hiyerarşik koşuda retry: aynı koşunun önceki denemesinde COMPLETED olan
 * delegasyonları atla ve maliyeti onlardan tohumla.
 *
 * Yönetici bir LLM döngüsüdür; retry'da baştan koşar ve delegasyonları yeniden ister.
 * Kimlik anahtarı = (workerAgentId, task metni) — tam eşleşme; her önceki COMPLETED satır
 * EN ÇOK BİR kez tüketilir (stepIndex sırasıyla; aynı anahtar iki kez istenirse iki satır
 * gerekir). Satır yalnız AYNI koşudan (runId + kiracı kapsamı) okunur. Şema/migration yok:
 * mevcut `run_steps` satırları (name "delegate:*", stepIndex > 0, input {agentId,task}).
 */
import { prisma } from "../../lib/db";

export interface PriorDelegation {
  id: string;
  stepIndex: number;
  agentId: string | null;
  task: string | null;
  output: unknown;
  costUsd: number;
}

export interface DelegationResumePlan {
  /** Anahtar → kuyruk (stepIndex artan). Tüketildikçe kısalır. */
  reusable: Map<string, PriorDelegation[]>;
  /** Önceki denemelerde tamamlanan TÜM delegasyonların maliyet toplamı. */
  seededCost: number;
  /**
   * Koşunun kayıtlı `run.costUsd` değeri (önceki denemelerin yönetici + FAILED/INTERRUPTED worker
   * harcaması dahil; COMPLETED delegasyon toplamından büyük olabilir). Retry maliyet sayacının TABANI:
   * `max(priorRunCost, seededCost)` (bkz. `startingCost`). İlk koşuda 0.
   */
  priorRunCost: number;
  /** Önceki delegasyon satırlarının (her durum) en büyük stepIndex'i; yeni satırlar bunun ardından. */
  maxStepIndex: number;
  completedCount: number;
}

export const delegationKey = (agentId: string, task: string): string => `${agentId}\u0000${task}`;

export function planDelegationResume(
  rows: Array<{
    id: string;
    stepIndex: number;
    status: string;
    agentId: string | null;
    input: unknown;
    output: unknown;
    costUsd: unknown;
  }>,
): DelegationResumePlan {
  const reusable = new Map<string, PriorDelegation[]>();
  let seededCost = 0;
  let maxStepIndex = 0;
  let completedCount = 0;
  const sorted = [...rows].sort((a, b) => a.stepIndex - b.stepIndex || a.id.localeCompare(b.id));
  for (const r of sorted) {
    if (r.stepIndex > maxStepIndex) maxStepIndex = r.stepIndex;
    if (r.status !== "COMPLETED") continue;
    const inp = (r.input ?? {}) as { agentId?: unknown; task?: unknown };
    const cost = Number(r.costUsd ?? 0) || 0;
    seededCost += cost;
    completedCount++;
    if (typeof inp.agentId !== "string" || typeof inp.task !== "string") continue; // eşleşemez ama maliyeti sayılır
    const key = delegationKey(inp.agentId, inp.task);
    const q = reusable.get(key) ?? [];
    q.push({ id: r.id, stepIndex: r.stepIndex, agentId: r.agentId, task: inp.task, output: r.output, costUsd: cost });
    reusable.set(key, q);
  }
  return { reusable, seededCost, priorRunCost: 0, maxStepIndex, completedCount };
}

/**
 * Retry'da kümülatif maliyet sayacının başlangıcı. Asla `run.costUsd`'nin altına düşmez:
 * yalnız COMPLETED delegasyonları tohumlamak, önceki denemenin yönetici/başarısız worker
 * harcamasını atlayıp `run.costUsd`'yi düşüğe yazdırır ve job bütçesini aşılabilir kılar.
 * Sonlu olmayan/negatif değerler 0 sayılır.
 */
export function startingCost(plan: Pick<DelegationResumePlan, "seededCost" | "priorRunCost">): number {
  const ok = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return Math.max(ok(plan.priorRunCost), ok(plan.seededCost));
}

/** Anahtara uyan ilk (en düşük stepIndex) kullanılmamış satırı tüketip döndürür; yoksa null. */
export function takeReusable(plan: DelegationResumePlan, agentId: string, task: string): PriorDelegation | null {
  const q = plan.reusable.get(delegationKey(agentId, task));
  if (!q || q.length === 0) return null;
  return q.shift() ?? null;
}

/** Aynı koşu + kiracı kapsamlı önceki delegasyon satırlarını yükler (başka koşu/kiracı asla). */
export async function loadDelegationResumePlan(runId: string, tenantId: string): Promise<DelegationResumePlan> {
  const [rows, run] = await Promise.all([
    prisma.runStep.findMany({
      where: {
        runId,
        stepIndex: { gt: 0 },
        name: { startsWith: "delegate:" },
        run: { pipeline: { company: { tenantId } } },
      },
      select: { id: true, stepIndex: true, status: true, agentId: true, input: true, output: true, costUsd: true },
      orderBy: { stepIndex: "asc" },
    }),
    // Kiracı kapsamlı (rule #10): yalnız bu kiracının koşusunun kayıtlı maliyeti.
    prisma.run.findFirst({
      where: { id: runId, pipeline: { company: { tenantId } } },
      select: { costUsd: true },
    }),
  ]);
  const plan = planDelegationResume(rows as never);
  plan.priorRunCost = Number((run as { costUsd?: unknown } | null)?.costUsd ?? 0) || 0;
  return plan;
}
