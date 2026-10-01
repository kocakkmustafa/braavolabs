import { prisma } from "../../lib/db";
import { holdingRunQueue } from "../../lib/queue";
import { logger } from "../../lib/logger";
import { heartbeat, ingestSentinelEvent } from "./sentinel";
import { sendSev0Alert } from "./telegram";
import type { HoldingSeverityStr } from "./types";

/**
 * S0 sensor endpoints (Nöbetçi §5B) — all DETERMINISTIC, all $0.
 *
 * Two classes live here:
 *  1. Pull sweeps (queue health + self-heartbeat) driven by the module's
 *     interval timer.
 *  2. The mail signal classifier: pure, table-driven routing of inbound
 *     store/infra mails into `sentinel_events`. The TRANSPORT (Gmail poll /
 *     forwarding hook) arrives with founder credentials — this layer is
 *     transport-agnostic on purpose so any carrier can feed it.
 *
 * Mail CONTENT is always UNTRUSTED (§3): it is classified by sender/subject
 * patterns only and never interpreted as instructions.
 */

// ── Mail classification ─────────────────────────────────

export interface InboundMail {
  from: string;
  subject: string;
  /**
   * Postanın DÜŞTÜĞÜ kutunun sahibi olan venture (ör. `burunfark@gmail.com`
   * → `burun-farki`). Konu deseninden GÜÇLÜDÜR: Apple'ın "Your app status
   * changed" gibi jenerik konulu postası desenle sahipsiz kalır, kutu
   * bilgisiyle doğru şirkete yazılır. Yalnız desen boş dönerse kullanılır —
   * konu açıkça başka bir uygulamayı işaret ediyorsa ona saygı gösterilir
   * (tek kutuya birden çok ürünün postası düşebilir).
   */
  mailboxVenture?: string;
  /** Stable dedup key; falls back to from|subject when the carrier has none. */
  messageId?: string;
  receivedAt?: string;
  /** Optional short excerpt — stored as payload, never parsed for commands. */
  snippet?: string;
}

export interface MailSignal {
  kind: string;
  severity: HoldingSeverityStr;
  venture: string | null;
}

/** App-name → venture attribution (subject scan, case-insensitive). */
const APP_VENTURE_PATTERNS: Array<[RegExp, string]> = [
  [/lifeos/i, "lifeos"],
  [/burun\s*fark/i, "burun-farki"],
  [/braavo/i, "braavolabs"],
  [/gravita/i, "gravita"],
  [/lissom/i, "lissom"],
  [/jablab/i, "jablab"],
  [/ostinato/i, "ostinato"],
  [/choreia/i, "choreia"],
  [/yulalab/i, "yulalab-com"],
];

/** Store "hard signal" markers — a rejection never waits for a patrol tick. */
const REJECTION_PATTERN = /(rejected|reddedildi|removed from sale|policy violation|ihlal|suspended|askıya)/i;
const DEADLINE_PATTERN = /(deadline|son tarih|action required|işlem gerekiyor|expires|sona eriyor)/i;
const GOOD_NEWS_PATTERN = /(approved|onayland|ready for sale|is now available|yayında)/i;

function ventureOf(subject: string): string | null {
  for (const [pattern, venture] of APP_VENTURE_PATTERNS) {
    if (pattern.test(subject)) return venture;
  }
  return null;
}

/**
 * Pure classifier — exported for tests and for the future S1 patrol, which
 * treats this output as ground truth the LLM may only ANNOTATE, never lower
 * (S1 hiçbir S0 sinyalini bastıramaz).
 */
export function classifyMail(mail: InboundMail): MailSignal {
  const from = mail.from.toLowerCase();
  const subject = mail.subject ?? "";
  // Desen önce: konu bir ürünü AÇIKÇA söylüyorsa kutu sahibini ezmez.
  const venture = ventureOf(subject) ?? (mail.mailboxVenture || null);

  if (from.includes("apple.com")) {
    if (REJECTION_PATTERN.test(subject)) return { kind: "store-apple-rejection", severity: "SEV1", venture };
    if (GOOD_NEWS_PATTERN.test(subject)) return { kind: "store-apple-status", severity: "INFO", venture };
    return { kind: "store-apple-mail", severity: "SEV2", venture };
  }
  if (from.includes("google.com") || from.includes("play.google")) {
    if (REJECTION_PATTERN.test(subject) || DEADLINE_PATTERN.test(subject)) {
      return { kind: "store-google-policy", severity: "SEV1", venture };
    }
    if (GOOD_NEWS_PATTERN.test(subject)) return { kind: "store-google-status", severity: "INFO", venture };
    return { kind: "store-google-mail", severity: "SEV2", venture };
  }
  if (from.includes("supabase")) {
    return DEADLINE_PATTERN.test(subject) || /paused|limit/i.test(subject)
      ? { kind: "infra-supabase-alert", severity: "SEV1", venture }
      : { kind: "infra-supabase-mail", severity: "SEV3", venture };
  }
  if (from.includes("sentry")) return { kind: "infra-sentry-mail", severity: "SEV2", venture };
  if (from.includes("github")) {
    const basarisiz = /fail|başarısız/i.test(subject);
    // Dependabot bağımlılık PR'ı CI OLAYI DEĞİLDİR. Ölçüm (2026-08-08): 96
    // saatlik pencerede GitHub postalarının çoğu `chore(deps)/build(deps)`
    // bump bildirimiydi — hepsini sinyale çevirmek gözcü tablosunu INFO
    // gürültüsüyle doldurur ve gerçek CI hatasını görünmez yapar.
    // İSTİSNA: bump PR'ı BAŞARISIZ olduysa gerçek bir CI sinyalidir.
    const bagimlilikBump = /\b(deps|dependabot|bump)\b/i.test(subject) || from.includes("dependabot");
    if (bagimlilikBump && !basarisiz) {
      return { kind: "ci-bagimlilik-bildirimi", severity: "SEV3", venture };
    }
    return basarisiz
      ? { kind: "ci-failure-mail", severity: "SEV2", venture }
      : { kind: "ci-mail", severity: "INFO", venture };
  }
  return { kind: "mail-other", severity: "INFO", venture };
}

/** Carrier-agnostic ingest: classify → sentinel event (UNTRUSTED, deduped). */
export async function ingestMailSignal(mail: InboundMail): Promise<{ id: string; deduped: boolean; signal: MailSignal }> {
  const signal = classifyMail(mail);
  const result = await ingestSentinelEvent({
    source: "mail-filter",
    kind: signal.kind,
    severity: signal.severity,
    trustLevel: "UNTRUSTED",
    payload: {
      from: mail.from,
      subject: mail.subject,
      venture: signal.venture,
      receivedAt: mail.receivedAt,
      snippet: mail.snippet?.slice(0, 500),
    },
    salient: mail.messageId ?? `${mail.from}|${mail.subject}`,
  });
  return { ...result, signal };
}

// ── Queue health + self-heartbeat sweep ─────────────────

/** Failed-job threshold before the dead-letter sensor raises. */
export const QUEUE_FAILED_THRESHOLD = 3;
const SWEEP_HEARTBEAT_SENSOR = "holding-sensor-sweep";
export const SWEEP_INTERVAL_SECONDS = 600;

/**
 * One sweep tick: (1) beat our own heartbeat — the sweep itself is on the
 * dead-man's switch, so a silently-dead motor becomes a SEV1 within ~20min;
 * (2) check the holding queue's dead-letter depth.
 */
export async function sweepSentinelSensors(): Promise<void> {
  await heartbeat(SWEEP_HEARTBEAT_SENSOR, SWEEP_INTERVAL_SECONDS);

  try {
    const counts = await holdingRunQueue.getJobCounts("failed");
    const failed = counts.failed ?? 0;
    if (failed >= QUEUE_FAILED_THRESHOLD) {
      await ingestSentinelEvent({
        source: "queue-health",
        kind: "holding-dead-letter",
        severity: "SEV2",
        trustLevel: "TRUSTED",
        payload: { failed },
        // Per-day salient: one event per bad day, dedupCount counts sweeps.
        salient: `holding-runs|${new Date().toISOString().slice(0, 10)}`,
      });
    }
  } catch (err) {
    logger.error({ err }, "queue-health sweep failed");
  }

  // (3) Motorun kendi durumu — günlük brief bileşeni (kurucu kararı 2026-08-08).
  //
  // Neden harici bir script değil: veri zaten burada. Neden GÜNDE BİR: süpürme
  // 10 dakikada bir koşuyor; her turda olay üretmek günde 144 eşdeğer kayıt
  // demek olurdu — `salient` gün bazlı olduğu için sonraki turlar aynı kaydı
  // KATLAR (dedupCount artar), yeni satır açmaz.
  //
  // Sağlıklı günde de üretilir: "hata yok" bilgisi brief'te bir SATIRDIR;
  // yalnız bozukken üretmek "sessizlik = her şey yolunda" yanılgısını doğurur.
  try {
    const gun = new Date().toISOString().slice(0, 10);
    const [toplam, basarisiz, bekleyenOnay, calisan] = await Promise.all([
      prisma.holdingWorkflowRun.count(),
      prisma.holdingStepRun.count({ where: { status: "FAILED" } }),
      prisma.holdingApproval.count({ where: { status: "PENDING" } }),
      prisma.holdingWorkflowRun.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    ]);
    await ingestSentinelEvent({
      source: "motor",
      kind: "motor-saglik",
      // Başarısız adım varsa SEV2, yoksa INFO — şiddet gerçeği yansıtsın.
      severity: basarisiz > 0 ? "SEV2" : "INFO",
      trustLevel: "TRUSTED",
      payload: { toplamKosu: toplam, basarisizAdim: basarisiz, bekleyenOnay, calisan },
      salient: `motor-saglik|${gun}`,
    });
  } catch (err) {
    logger.error({ err }, "motor-saglik sweep failed");
  }
}

// ── Cost Guard SEV0 fan-out ─────────────────────────────

/**
 * Hook for cost-guard recordSpend({ onRateAlarm }): turns a spend-rate trip
 * into a persisted SEV0 + Telegram alert. MUST be wired by whichever step
 * kind first spends real money (see runner.ts constraint note).
 */
export async function costRateAlarm(spentUsd: number): Promise<void> {
  await ingestSentinelEvent({
    source: "cost-guard",
    kind: "spend-rate-freeze",
    severity: "SEV0",
    trustLevel: "TRUSTED",
    payload: { spentUsd },
    onSev0: async () => {
      await sendSev0Alert(
        `Harcama-hız sensörü tetiklendi: 5 dakikada $${spentUsd.toFixed(2)} — holding harcaması DONDURULDU (freeze). Reset yalnız kurucu.`,
      );
    },
  });
}
