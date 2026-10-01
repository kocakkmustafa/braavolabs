import { prisma } from "../../lib/db";
import { enqueueRun } from "../pipeline/runner";
import { ensureYulaTenant } from "./tenant";
import { classifyMail, type InboundMail } from "./sensors";
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
      return executePipeline(step, runInput, opts);
    case "publish":
      return executePublish(step);
    case "report":
      return executeReport(step, runInput);
    default:
      throw new ExtendedStepError(`extended kind değil: ${step.kind}`);
  }
}

/**
 * `publish` — sosyal yayın turunu sürer (D5, 2026-08-07).
 *
 * Bir tur: Telegram callback'lerini işle → hatırlatmaları gönder → penceresi
 * dolanları auto-approve et → onaylananları gerçek API ile yayınla.
 * Yayın hattının kendisi `social/` altındadır ve Mac'te CANLI KANITLANMIŞ
 * Python kodunun portudur.
 *
 * Deterministik ve $0: LLM çağırmaz. Yayın izni tamamen onay kuyruğundan
 * gelir — bu adım kendiliğinden içerik üretmez, yalnız onaylanmışı taşır.
 */
async function executePublish(step: HoldingStepDef): Promise<Record<string, unknown>> {
  const { runTurn } = await import("./social/orchestrator");
  const dryRun = step.params?.dryRun === true;
  const summary = await runTurn({ dryRun });
  return {
    onaylanan: summary.approved,
    atlanan: summary.skipped,
    hatirlatma: summary.reminders,
    zaman_asimi_onayi: summary.timeouts,
    yayinlanan: summary.published.length,
    basarisiz: summary.failures.length,
    yayinlar: summary.published.map((p) => ({
      marka: p.row.brand,
      platform: p.result.platform,
      url: p.result.platformUrl ?? null,
      onay: p.row.approved_by === "timeout" ? "sessizlik" : "kurucu",
    })),
    hatalar: summary.failures.map((f) => ({
      marka: f.row.brand,
      platform: f.result.platform,
      hata: (f.result.error ?? "").slice(0, 300),
    })),
  };
}

/**
 * `report` — Slack'e anlamlı bir olay bildirir (D5, 2026-08-07).
 *
 * Kurucu kararı: "anlamlı olaylar + günlük özet" — her tekil adım değil.
 * Bu yüzden rapor adımı bilinçli olarak workflow'un İÇİNE konur: neyin
 * raporlanacağına workflow tasarımı karar verir, motor her nefeste
 * Slack'e yazmaz.
 */
async function executeReport(
  step: HoldingStepDef,
  runInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { notifySlack } = await import("./slack");
  const project = String(step.params?.project ?? runInput.project ?? "holding");
  const title = String(step.params?.title ?? step.name);
  const kind = String(step.params?.event ?? "workflow.completed");
  const fields = (step.params?.fields as Record<string, string>) ?? undefined;
  const sent = await notifySlack({
    kind: kind as never,
    project: project as never,
    title,
    fields,
    url: step.params?.url ? String(step.params.url) : undefined,
  });

  // İKİ KANAL (kurucu kararı 2026-08-08): Telegram + Slack. Paralel değil
  // sıralı çağrılır ve ikisi de AYRI raporlanır — "gönderildi" tek bir bayrağa
  // indirilirse bir kanalın sessizce düşmesi görünmez olur.
  const { sendReport } = await import("./telegram");
  const govde =
    (step.params?.body ? String(step.params.body) : "") ||
    (fields ? Object.entries(fields).map(([k, v]) => `• ${k}: ${v}`).join("\n") : "") ||
    String(runInput.ozet ?? "(içerik yok)");
  const tgSent = await sendReport(title, govde);

  return { slack_gonderildi: sent, telegram_gonderildi: tgSent, proje: project, baslik: title };
}

async function executeClassify(step: HoldingStepDef, runInput: Record<string, unknown>) {
  const mode = String(step.params?.mode ?? "mail");
  if (mode === "mail") {
    const mail = (step.params?.mail ?? runInput.mail) as InboundMail | undefined;
    if (!mail?.from || typeof mail.subject !== "string") {
      throw new ExtendedStepError("classify(mail): girdi şeması eksik ({from, subject} zorunlu)");
    }
    const signal = classifyMail(mail);
    // 2026-08-07: Danışman öneri katmanı (Fable Mental) KALDIRILDI — kurucu kararı,
    // Claude yönlendirilmeden çalışıyor. Eskalasyon artık sinyalin kendisiyle gider;
    // "hangi danışmana sor" ekini motor üretmez.
    return { signal };
  }
  // Tabloda olmayan mod = tahmin yok, eskalasyon (run FAILED → bildirim).
  throw new ExtendedStepError(`classify: '${mode}' modu tanımsız — ESKALE (LLM zinciri K3 sonrası)`);
}

/**
 * `params.kinds` desenleri: tam ad (`ci-failure-mail`) veya sonek joker
 * (`store-*`). Boş bırakılırsa workflow HER olayı üstlenir (süpürücü rolü).
 */
function matchesKind(kind: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? kind.startsWith(p.slice(0, -1)) : kind === p));
}

async function executePatrol(step: HoldingStepDef) {
  const scope = String(step.params?.scope ?? "sentinel-summary");
  if (scope !== "sentinel-summary") {
    throw new ExtendedStepError(`patrol: '${scope}' kapsamı tanımsız — ESKALE`);
  }
  // Alan süzgeci (H-026). Süzgeç YOKKEN patrol `NEW` olayların TAMAMINI okuyup
  // tüketiyordu; 12 patrol workflow'u etkinken alfabetik olarak ilk koşan
  // hepsini yutuyor, kalan 11'i `scanned: 0` görüyordu. Ölçülen sonuç: Google
  // Play son-tarih uyarısı ve `lissom` CI hataları "abonelik süpürmesi"ne
  // yazıldı — sayı doğru, SAHİP yanlış. Süzgeç, her workflow'un yalnız kendi
  // alanının sinyalini üstlenmesini sağlar.
  const kinds = Array.isArray(step.params?.kinds) ? (step.params.kinds as string[]) : null;

  const candidates = await prisma.holdingSentinelEvent.findMany({
    where: { status: "NEW" },
    take: 200,
    orderBy: { createdAt: "asc" },
  });
  const events = kinds ? candidates.filter((e) => matchesKind(e.kind, kinds)) : candidates;

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
  // `matched` ile `scanned` ayrı raporlanır: süzgeç yüzünden mi 0 gördük,
  // yoksa ortada hiç yeni olay yok muydu — ikisi farklı teşhis.
  return { scanned: events.length, candidates: candidates.length, filter: kinds, summary };
}

async function executePipeline(
  step: HoldingStepDef,
  runInput: Record<string, unknown>,
  opts: ExtendedStepOpts,
) {
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
      // Hat, kendisinden ÖNCEKİ adımın çıktısını görür. Aksi halde ürün hattı
      // boş girdiyle koşar ve model "veri verilmedi" der — koşu SUCCEEDED
      // görünür ama rapor boştur (2026-08-08'de ölçüldü).
      input: {
        ...((step.params?.input ?? {}) as Record<string, unknown>),
        veri: (runInput as Record<string, unknown>)?.oncekiAdim ?? null,
      } as object,
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
