/**
 * BRA-P0-03e — PENDING koşu süpürücüsü (ADR-0003 03b notu).
 *
 * Koşu yaratımı ile `enqueueRun` ayrı adımlardır (jobs/start, pipelines/:id/run, webhook,
 * zamanlanmış tetik). Süreç ikisinin arasında ölürse satır `PENDING` kalır ve kuyrukta
 * hiçbir iş yoktur; `POST /jobs/start` aynı idempotency anahtarıyla tekrarlanırsa replay
 * bu ölü koşuyu döndürür ve iş hiç başlamaz. Bu süpürücü tek bir koşuyu iki yoldan biriyle kapatır:
 *
 *   yaş ∈ [GRACE, MAX_AGE]  → yeniden kuyruğa al (`enqueueRun`, sabit jobId `run-<id>`)
 *   yaş > MAX_AGE           → FAILED (`pending_orphaned`): günler sonra habersiz başlayan,
 *                             kullanıcının terk ettiği bir iş sürpriz harcama yaratmasın.
 *                             Durum grafiğine bağlı değil (READY→FAILED kenarı yok): kiracı kapsamlı
 *                             okuma + `status=PENDING` skaler CAS; bayrak açıkken `state` de FAILED.
 *                             Kota iadesi (BRA-P0-03e-b): yalnız koşu İÇİNDE BULUNULAN UTC ayında yaratıldıysa
 *                             (`releaseQuota` hep geçerli ayın sayacını düşer; önceki aya ait koşu için
 *                             iade yanlış ayı düşerdi, o ayın sayacı kapandı → atlanır). Bayrak açıkken
 *                             FAILED makbuzu da yazılır (best-effort, geçişi bozmaz).
 *   yaş < GRACE             → dokunma (normal yaratım→kuyruk penceresi)
 *
 * Güvenceler:
 *  - İdempotent: ikinci süpürme etkisiz. Önce kuyruktaki canlı iş (waiting/active/delayed/
 *    prioritized) `data.runId` ile aranır; varsa dokunulmaz. Süpürücünün kendi `jobId`'si
 *    BullMQ'da yinelenen eklemeyi engeller (iki API süreci aynı Redis'i paylaşsa da). Aynı id'li
 *    BİTMİŞ (completed/failed) iş koşuyu yürütmemiştir (satır hâlâ PENDING) ve `removeOn*`
 *    tutuyorsa yeni eklemeyi sessizce yutardı: önce kaldırılır.
 *  - Kiracı kapsamı: aday sorgusu `pipeline.company.tenantId` üzerinden; `tenantId` verilirse yalnız
 *    o kiracı. Kuyruk yükü ve FAILED yazımı koşunun KENDİ kiracısıyla yapılır (`enqueueRun`
 *    kiracıyı DB'den türetir; `transitionRun` kiracı kapsamlı).
 *  - Durum yarışı: her yazımdan önce kiracı kapsamlı taze okuma (PENDING değilse dokunulmaz), FAILED
 *    yazımı `status=PENDING` CAS'lı; kuyruk taraması dolarsa (≥5000) yeniden kuyruğa alma yapılmaz.
 *  - İkinci bariyer (BRA-P0-03e-b): `processRun` artık PENDING/RUNNING dışı koşuyu reddeder; bu
 *    dosyadaki canlı-iş taraması + jobId dedupe + taze durum okuması birinci bariyerdir.
 *  - Bayrak (`JOB_STATE_DUAL_WRITE`) KAPALIYKEN `state` kolonu adlandırılmaz (migration öncesi
 *    şema güvenli); AÇIKKEN yalnız `state` null/READY (DRAFT/PLANNED PENDING'ler başlatılmayı
 *    beklemez, dokunulmaz).
 *  - Şema/migration yok; tek koşunun hatası diğerlerini durdurmaz.
 */
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runQueue } from "../../lib/queue";
import { runWithoutTenant } from "../../lib/tenant-context";
import { releaseQuota } from "../billing/metering";
import { sameUtcMonth } from "../billing/period";
import { enqueueRun } from "../pipeline/runner";
import type { JobState } from "./job-state";
import { isJobStateDualWriteEnabled, tryWriteReceipt } from "./transition";

/** Yaratım→kuyruk normal penceresi: bundan genç PENDING'e dokunulmaz. */
export const PENDING_GRACE_MS = 10 * 60_000;
/** Bundan eski PENDING yeniden başlatılmaz, FAILED yapılır. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60_000;
export const PENDING_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Tek süpürmede en çok bu kadar aday (en eskiden başlar). */
export const PENDING_SWEEP_BATCH = 50;
/** Kuyruk taraması üst sınırı (canlı iş araması). */
const LIVE_SCAN_LIMIT = 5_000;

export const sweepJobId = (runId: string): string => `run-${runId}`;

export interface PendingSweepResult {
  scanned: number;
  requeued: number;
  failed: number;
  skippedQueued: number;
  /** Aday listelendikten sonra PENDING olmaktan çıkan (işçi aldı/iptal) ya da CAS'ı kaybeden koşular. */
  skippedChanged: number;
  /** Kuyruk taraması doldu (≥ LIVE_SCAN_LIMIT): canlı iş yokluğu KANITLANAMADI, yeniden kuyruğa alma yapılmadı. */
  skippedUnverified: number;
  errors: number;
}

export interface PendingSweepOptions {
  /** Verilirse yalnız bu kiracının koşuları. */
  tenantId?: string;
  now?: number;
  /** Bayrağı ezer (testler). */
  dualWrite?: boolean;
}

/**
 * Kuyrukta canlı (henüz bitmemiş) işi olan koşu kimlikleri; sweep başına BİR kez taranır.
 * `complete=false`: tarama sınıra dayandı, daha eski canlı iş görünmemiş olabilir → çağıran
 * yeniden kuyruğa almaz (çift enqueue'dan kaçınmak için güvenli taraf).
 */
async function scanLiveRunIds(): Promise<{ ids: Set<string>; complete: boolean }> {
  const jobs = await runQueue.getJobs(["waiting", "active", "delayed", "prioritized"], 0, LIVE_SCAN_LIMIT - 1);
  const ids = new Set<string>();
  for (const j of jobs) {
    const id = (j?.data as { runId?: string } | undefined)?.runId;
    if (id) ids.add(id);
  }
  return { ids, complete: jobs.length < LIVE_SCAN_LIMIT };
}

/** Süpürücünün önceki, BİTMİŞ aynı-id'li işini kaldırır (koşu hâlâ PENDING: iş onu yürütmedi). */
async function clearFinishedSweepJob(runId: string): Promise<void> {
  const prev = await runQueue.getJob(sweepJobId(runId));
  if (!prev) return;
  const state = await prev.getState();
  if (state === "completed" || state === "failed") await prev.remove();
}

/** Denetim satırı geçişten/kuyruktan SONRA ve best-effort: yazılamazsa koşu `errors`a düşmez. */
async function auditBestEffort(tenantId: string, runId: string, action: string, ageMs: number): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: { tenantId, actor: "system", action, resource: "run", resourceId: runId, details: { ageMs } },
    });
  } catch (err) {
    logger.warn({ err, runId, action }, "PENDING sweeper: activity log failed (non-fatal)");
  }
}

export async function sweepPendingRuns(opts: PendingSweepOptions = {}): Promise<PendingSweepResult> {
  const now = opts.now ?? Date.now();
  const dual = opts.dualWrite ?? isJobStateDualWriteEnabled();
  const result: PendingSweepResult = { scanned: 0, requeued: 0, failed: 0, skippedQueued: 0, skippedChanged: 0, skippedUnverified: 0, errors: 0 };

  const candidates = await prisma.run.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: new Date(now - PENDING_GRACE_MS) },
      pipeline: { company: opts.tenantId ? { tenantId: opts.tenantId } : {} },
      // Bayrak kapalıyken `state` adlandırılmaz.
      ...(dual ? { OR: [{ state: null }, { state: "READY" }] } : {}),
    },
    select: { id: true, createdAt: true, pipeline: { select: { company: { select: { tenantId: true } } } } },
    orderBy: { createdAt: "asc" },
    take: PENDING_SWEEP_BATCH,
  });
  result.scanned = candidates.length;

  // Kuyruk taraması tembel ve sweep başına tek: yalnız yeniden kuyruğa alınacak aday varsa yapılır.
  let live: { ids: Set<string>; complete: boolean } | null = null;
  const tenantScope = (id: string, t: string) => ({ id, pipeline: { company: { tenantId: t } } });

  for (const run of candidates) {
    const tenantId = run.pipeline?.company?.tenantId;
    if (!tenantId) {
      result.errors++;
      logger.warn({ runId: run.id }, "PENDING sweeper: run has no tenant — skipped");
      continue;
    }
    try {
      const age = now - run.createdAt.getTime();
      // Her yazımdan önce kiracı kapsamlı TAZE okuma: aday listelendikten sonra işçi koşuyu aldıysa
      // (RUNNING/COMPLETED…) ya da iptal edildiyse dokunulmaz (bayat aday yarışı).
      const fresh = (await prisma.run.findFirst({
        where: tenantScope(run.id, tenantId),
        select: dual ? { status: true, state: true } : { status: true },
      })) as { status: string; state?: JobState | null } | null;
      if (!fresh || fresh.status !== "PENDING") {
        result.skippedChanged++;
        continue;
      }

      if (age > PENDING_MAX_AGE_MS) {
        // Durum grafiğine (READY→FAILED kenarı yok) bağlı DEĞİL: hiç başlamamış koşunun terk edilmesi.
        // Skaler CAS (kiracı yukarıdaki okumada doğrulandı); bayrak açıkken `state` de FAILED olur.
        const res = await prisma.run.updateMany({
          where: { id: run.id, status: "PENDING", ...(dual ? { state: fresh.state ?? null } : {}) },
          data: { status: "FAILED", ...(dual ? { state: "FAILED" } : {}), error: "pending_orphaned", completedAt: new Date() },
        });
        if (res.count !== 1) {
          result.skippedChanged++;
          continue;
        }
        result.failed++;
        // Bundan sonrası CAS sonrası yan etkilerdir: biri patlarsa FAILED geçişi/diğer adımlar bozulmaz.
        if (dual) await tryWriteReceipt(prisma, run.id, "FAILED", tenantId);
        if (sameUtcMonth(run.createdAt, now)) await releaseQuota(tenantId, "runs");
        await auditBestEffort(tenantId, run.id, "run.pending_orphaned", age);
        continue;
      }

      live ??= await scanLiveRunIds();
      if (live.ids.has(run.id)) {
        result.skippedQueued++;
        continue;
      }
      if (!live.complete) {
        result.skippedUnverified++;
        continue;
      }
      await clearFinishedSweepJob(run.id);
      await enqueueRun(run.id, { jobId: sweepJobId(run.id) });
      live.ids.add(run.id);
      result.requeued++;
      await auditBestEffort(tenantId, run.id, "run.pending_requeued", age);
    } catch (err) {
      result.errors++;
      logger.error({ err, runId: run.id }, "PENDING sweeper: run failed — continuing with the rest");
    }
  }
  if (result.requeued || result.failed || result.errors || result.skippedUnverified) logger.info(result, "PENDING sweeper tick");
  return result;
}

/** Cron girişi: tüm kiracıları kapsar (BR-P0-004: tek kiracı bağlamı yok). */
export function runPendingSweep(opts: PendingSweepOptions = {}): Promise<PendingSweepResult> {
  return runWithoutTenant("cron:pending-sweeper", () => sweepPendingRuns(opts));
}

let sweepTimer: NodeJS.Timeout | null = null;

export function initPendingSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runPendingSweep().catch((err) => logger.error({ err }, "PENDING sweeper tick failed"));
  }, PENDING_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  logger.info("PENDING sweeper initialized (5 min tick, 10 min grace, 24 h max age)");
}

export function stopPendingSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
