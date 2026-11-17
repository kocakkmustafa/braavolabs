/**
 * BRA-UX-API-05b — ajan yanıtını iş sohbetine (JobMessage ASSISTANT) yazar.
 *
 * Yeni LLM çağrısı YOK: ajan döngüsü steer mesajını tükettikten sonraki turda zaten ürettiği METİN (`result.content`)
 * kaydedilir. Araç çağrıları/çıktıları, ham ipucu, sistem istemi buraya HİÇ gelmez (çağıran yalnız turun metnini verir).
 * Yalnız sohbetten (POST /runs/:id/chat) gelen steer'lere yanıt yazılır: tüketilen STEER içeriği, aynı koşunun USER
 * JobMessage'ıyla birebir eşleşmeliyse (`/steer` ve INPUT yanıtları sohbet değildir → kayıt yok).
 * Şemada replyTo alanı YOK (sütun eklenmez): bağ ve idempotans `ActivityLog(run.chat.reply).details.replyToMessageIds`.
 * Hata ASLA ajan döngüsünü bozmaz (çağıran try/catch + non-fatal).
 */
import { containsRawSecret, CHAT_MAX_CONTENT, CHAT_MAX_MESSAGES_PER_RUN } from "./chat";

export const ASSISTANT_TRUNCATION_MARK = "\n\n[…yanıt kısaltıldı]";
export const ASSISTANT_REDACTED_TEXT = "[Yanıt, hassas veri içerebileceği için gizlendi.]";
export const CHAT_REPLY_ACTION = "run.chat.reply";

export interface DrainedSteer { kind: string; content: string }

export const ASSISTANT_INTERNAL_TEXT = "[Yanıt, dahili araç/sistem içeriği taşıdığı için gizlendi.]";
export const ASSISTANT_MASK = "[gizlendi]";
/** Ham araç-çağrısı işaretlemesi (prompt-fallback), sistem istemi ve araç çıktısı kalıpları → tüm metin yer tutucuya döner. */
const INTERNAL_PATTERNS: readonly RegExp[] = [
  /<\/?\s*(?:tool_call|tool_calls|tool_use|tool_result|function_call|function_calls|function_results|invoke|antml:[a-z_]+)\b/i,
  /"(?:tool_calls?|tool_use_id|toolCallId|argumentsJson|function_call)"\s*:/i,
  /"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input|parameters)"\s*:/i,
  /^\s*Available tools:/im,
  /\[(?:Operator steering|Human-in-the-loop answer|Tool result|tool_result)/i,
  /\b(?:system prompt|sistem istemi)\s*[:=]/i,
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LONG_DIGITS_RE = /\+?\d(?:[ .-]?\d){8,}/g;

/**
 * Uzunluk sınırı (CHAT_MAX_CONTENT, işaret dahil) ve sızıntı süzgeci. Boşsa null.
 * SINIR (kabul edilmiş): kalıp tabanlı. Model önceki bir araç çıktısını kendi cümleleriyle ÖZETLERSE tam engel yok;
 * yalnız ham işaretleme, sır, e-posta ve uzun rakam dizileri yakalanır.
 */
export function sanitizeAssistantText(raw: string): string | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  if (containsRawSecret(text)) return ASSISTANT_REDACTED_TEXT;
  if (INTERNAL_PATTERNS.some((re) => re.test(text))) return ASSISTANT_INTERNAL_TEXT;
  text = text.replace(EMAIL_RE, ASSISTANT_MASK).replace(LONG_DIGITS_RE, ASSISTANT_MASK);
  if (text.length <= CHAT_MAX_CONTENT) return text;
  return text.slice(0, CHAT_MAX_CONTENT - ASSISTANT_TRUNCATION_MARK.length) + ASSISTANT_TRUNCATION_MARK;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** @returns oluşturulan ASSISTANT mesajının id'si; yazılmadıysa null. */
export async function recordAssistantReply(
  db: any,
  input: { tenantId: string; runId: string; steers: DrainedSteer[]; content: string },
): Promise<string | null> {
  const text = sanitizeAssistantText(input.content);
  if (!text) return null;
  const chatSteers = input.steers.filter((s) => s.kind === "STEER");
  if (chatSteers.length === 0) return null;
  const { tenantId, runId } = input;

  return db.$transaction(async (tx: any) => {
    // Eşzamanlı iki tüketici/yazıcı aynı kullanıcı mesajına çift yanıt yazmasın: koşu başına işlem-kapsamlı kilit
    // (consume CAS'ına göre daha az invaziv: mevcut çift-tüketim davranışı ve updateMany çağrısı değişmez).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${runId}))`;
    // Kiracı kapsamı + yazımdan hemen önce durum yeniden okunur: iptal/duraklatma/onay beklemede yazma.
    const run = await tx.run.findFirst({ where: { id: runId, pipeline: { company: { tenantId } } }, select: { id: true, status: true } });
    if (!run || NO_WRITE_STATUSES.includes(run.status)) return null;
    // En yeni -> eski; her steer, aynı içerikli EN YENİ ve henüz yanıtsız kullanıcı mesajına bağlanır.
    const users: Array<{ id: string; content: string }> = await tx.jobMessage.findMany({
      where: { tenantId, runId, role: "USER", content: { in: chatSteers.map((s) => s.content) } },
      select: { id: true, content: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    const replyTo: string[] = [];
    for (const s of chatSteers) {
      for (const u of users) {
        if (u.content !== s.content || replyTo.includes(u.id)) continue;
        // İdempotans: yanıtlanmış mesaj atlanır (dizi argümanlı array_contains, bkz. test).
        const done = await tx.activityLog.findFirst({ where: replyLogWhere(tenantId, runId, u.id), select: { id: true } });
        if (done) continue;
        replyTo.push(u.id);
        break;
      }
    }
    if (replyTo.length === 0) return null;
    const count = await tx.jobMessage.count({ where: { tenantId, runId } });
    if (count >= CHAT_MAX_MESSAGES_PER_RUN) return null;
    const created = await tx.jobMessage.create({ data: { tenantId, runId, role: "ASSISTANT", content: text, authorUserId: null } });
    await tx.activityLog.create({
      data: { tenantId, actor: "system", action: CHAT_REPLY_ACTION, resource: "run", resourceId: runId, details: { messageId: created.id, replyToMessageIds: replyTo } },
    });
    return created.id as string;
  });
}

/** İdempotans sorgusu şekli (testle pinlenir; gerçek Postgres'te doğrulandı). */
export function replyLogWhere(tenantId: string, runId: string, userMessageId: string) {
  return { tenantId, action: CHAT_REPLY_ACTION, resourceId: runId, details: { path: ["replyToMessageIds"], array_contains: [userMessageId] } };
}
const NO_WRITE_STATUSES: readonly string[] = ["CANCELLED", "PAUSED", "WAITING_APPROVAL"];
