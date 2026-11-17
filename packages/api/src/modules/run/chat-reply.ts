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

/** Uzunluk sınırı (CHAT_MAX_CONTENT, işaret dahil) ve sır süzgeci. Boşsa null. */
export function sanitizeAssistantText(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (containsRawSecret(text)) return ASSISTANT_REDACTED_TEXT;
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
    // Kiracı kapsamı: koşu bu kiracıya ait olmalı (yoksa yazma).
    const run = await tx.run.findFirst({ where: { id: runId, pipeline: { company: { tenantId } } }, select: { id: true } });
    if (!run) return null;
    const users: Array<{ id: string; content: string }> = await tx.jobMessage.findMany({
      where: { tenantId, runId, role: "USER", content: { in: chatSteers.map((s) => s.content) } },
      select: { id: true, content: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const replyTo: string[] = [];
    for (const s of chatSteers) {
      const u = users.find((m) => m.content === s.content && !replyTo.includes(m.id));
      if (u) replyTo.push(u.id);
    }
    if (replyTo.length === 0) return null;
    // İdempotans: bu kullanıcı mesajlarından biri zaten yanıtlandıysa ikinci ASSISTANT yok.
    for (const id of replyTo) {
      const done = await tx.activityLog.findFirst({
        where: { tenantId, action: CHAT_REPLY_ACTION, resourceId: runId, details: { path: ["replyToMessageIds"], array_contains: id } },
        select: { id: true },
      });
      if (done) return null;
    }
    const count = await tx.jobMessage.count({ where: { tenantId, runId } });
    if (count >= CHAT_MAX_MESSAGES_PER_RUN) return null;
    const created = await tx.jobMessage.create({ data: { tenantId, runId, role: "ASSISTANT", content: text, authorUserId: null } });
    await tx.activityLog.create({
      data: { tenantId, actor: "system", action: CHAT_REPLY_ACTION, resource: "run", resourceId: runId, details: { messageId: created.id, replyToMessageIds: replyTo } },
    });
    return created.id as string;
  });
}
