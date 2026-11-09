/**
 * BRA-P0-04d — `Run.heartbeatAt` yazıcısı (ADR-0003).
 *
 * `jobBucket()` / `bucketWhere()` (04b) bayat kalp atışlı RUNNING'i `stuck` sayar
 * (eşik: `jobStaleAfterMs()`, tek kaynak). Bu dosya o kalp atışını YAZAN tek yerdir:
 * koşuyu yürüten runner'lar adım başında/sonunda `beatRun` çağırır.
 *
 *  - `JOB_STATE_DUAL_WRITE` KAPALI: hiçbir sorgu/yazma yok, `heartbeatAt` kolonu
 *    adlandırılmaz (migration öncesi şema ile de güvenli); davranış değişmez.
 *  - Açık: aynı koşu için en çok `HEARTBEAT_MIN_INTERVAL_MS` (30 sn) aralıkla,
 *    hafıza içi son-yazım zamanıyla kısıtlanır. Eşik 15 dk olduğundan 30 sn
 *    ~30 kat pay bırakır; sabit tekrar yazma yok.
 *  - Yazma yalnız `status = RUNNING` satırına, kiracı kapsamlı (pipeline → company
 *    → tenantId ilişki filtresi) yapılır: durdurulmuş/duraklatılmış koşuya kalp
 *    atışı yazılmaz.
 *  - Hata koşuyu bozmaz: yutulur, activity_log yazılmaz (gürültü yok), yalnız debug log.
 */
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { isJobStateDualWriteEnabled } from "./transition";

export const HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/** Süreç içi son-yazım zamanı (ms). Sınır aşılırsa en eski girdiler atılır. */
const lastBeat = new Map<string, number>();
const MAX_TRACKED_RUNS = 5_000;

/** Koşu bittiğinde/terk edildiğinde hafızayı boşalt. */
export function forgetBeat(runId: string): void {
  lastBeat.delete(runId);
}

/** Yalnız testler için. */
export function resetHeartbeatState(): void {
  lastBeat.clear();
}

export interface BeatOptions {
  /** Kısıtı atla (koşu alımı / retry): taze bir kalp atışı hemen yazılsın. */
  force?: boolean;
  /** Bayrağı ezer (testler). */
  dualWrite?: boolean;
  now?: number;
  /** Varsayılan: paylaşılan `prisma`; retry yolu kendi tx istemcisini verir. */
  client?: { run: { updateMany(args: any): PromiseLike<{ count: number }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Yazıldıysa true. Asla fırlatmaz. */
export async function beatRun(runId: string, tenantId: string, opts: BeatOptions = {}): Promise<boolean> {
  try {
    if (!(opts.dualWrite ?? isJobStateDualWriteEnabled())) return false;
    if (!tenantId) return false;
    const now = opts.now ?? Date.now();
    const last = lastBeat.get(runId);
    if (!opts.force && last !== undefined && now - last < HEARTBEAT_MIN_INTERVAL_MS) return false;

    // Yazımdan ÖNCE işaretle: paralel adımlar aynı pencerede ikinci yazımı yapmasın.
    if (lastBeat.size >= MAX_TRACKED_RUNS) {
      const oldest = lastBeat.keys().next().value;
      if (oldest !== undefined) lastBeat.delete(oldest);
    }
    lastBeat.delete(runId); // Map sırasını tazele (en yeni sonda)
    lastBeat.set(runId, now);

    const client = opts.client ?? prisma;
    const res = await client.run.updateMany({
      where: { id: runId, status: "RUNNING", pipeline: { company: { tenantId } } },
      data: { heartbeatAt: new Date(now) },
    });
    return res.count === 1;
  } catch (err) {
    logger.debug({ runId, err: err instanceof Error ? err.message : String(err) }, "Run heartbeat write failed — ignored");
    return false;
  }
}
