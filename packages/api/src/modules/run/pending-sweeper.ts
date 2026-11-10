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
 *                             kullanıcının terk ettiği bir iş sürpriz harcama yaratmasın
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
 *  - Durum yarışı: FAILED yazımı `onlyIfStatus: ["PENDING"]` + CAS; arada başlayan koşu ezilmez.
 *  - Bayrak (`JOB_STATE_DUAL_WRITE`) KAPALIYKEN `state` kolonu adlandırılmaz (migration öncesi
 *    şema güvenli); AÇIKKEN yalnız `state` null/READY (DRAFT/PLANNED PENDING'ler başlatılmayı
 *    beklemez, dokunulmaz).
 *  - Şema/migration yok; tek koşunun hatası diğerlerini durdurmaz.
 */
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runQueue } from "../../lib/queue";
import { runWithoutTenant } from "../../lib/tenant-context";
import { enqueueRun } from "../pipeline/runner";
import { isJobStateDualWriteEnabled, transitionRun } from "./transition";

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
  errors: number;
}

export interface PendingSweepOptions {
  /** Verilirse yalnız bu kiracının koşuları. */
  tenantId?: string;
  now?: number;
  /** Bayrağı ezer (testler). */
  dualWrite?: boolean;
}

/** Kuyrukta bu koşu için canlı (henüz bitmemiş) bir iş var mı. */
async function hasLiveJob(runId: string): Promise<boolean> {
  const jobs = await runQueue.getJobs(["waiting", "active", "delayed", "prioritized"], 0, LIVE_SCAN_LIMIT - 1);
  return jobs.some((j) => (j?.data as { runId?: string } | undefined)?.runId === runId);
}

/** Süpürücünün önceki, BİTMİŞ aynı-id'li işini kaldırır (koşu hâlâ PENDING: iş onu yürütmedi). */
async function clearFinishedSweepJob(runId: string): Promise<void> {
  const prev = await runQueue.getJob(sweepJobId(runId));
  if (!prev) return;
  const state = await prev.getState();
  if (state === "completed" || state === "failed") await prev.remove();
}

export async function sweepPendingRuns(opts: PendingSweepOptions = {}): Promise<PendingSweepResult> {
  const now = opts.now ?? Date.now();
  const dual = opts.dualWrite ?? isJobStateDualWriteEnabled();
  const result: PendingSweepResult = { scanned: 0, requeued: 0, failed: 0, skippedQueued: 0, errors: 0 };

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

  for (const run of candidates) {
    const tenantId = run.pipeline?.company?.tenantId;
    if (!tenantId) {
      result.errors++;
      logger.warn({ runId: run.id }, "PENDING sweeper: run has no tenant — skipped");
      continue;
    }
    try {
      const age = now - run.createdAt.getTime();
      if (age > PENDING_MAX_AGE_MS) {
        const o = await transitionRun(prisma, run.id, "FAILED", {
          tenantId,
          legacyUnchecked: true,
          onlyIfStatus: ["PENDING"],
          extra: { error: "pending_orphaned", completedAt: new Date() },
        });
        if (o.ok && !o.noop) {
          result.failed++;
          await prisma.activityLog.create({
            data: { tenantId, actor: "system", action: "run.pending_orphaned", resource: "run", resourceId: run.id, details: { ageMs: age } },
          });
        }
        continue;
      }
      if (await hasLiveJob(run.id)) {
        result.skippedQueued++;
        continue;
      }
      await clearFinishedSweepJob(run.id);
      await enqueueRun(run.id, { jobId: sweepJobId(run.id) });
      result.requeued++;
      await prisma.activityLog.create({
        data: { tenantId, actor: "system", action: "run.pending_requeued", resource: "run", resourceId: run.id, details: { ageMs: age } },
      });
    } catch (err) {
      result.errors++;
      logger.error({ err, runId: run.id }, "PENDING sweeper: run failed — continuing with the rest");
    }
  }
  if (result.requeued || result.failed || result.errors) logger.info(result, "PENDING sweeper tick");
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
