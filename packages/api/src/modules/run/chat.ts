/**
 * BRA-UX-API-05 — iş sohbeti: `GET/POST /runs/:id/chat`.
 *
 * Model: JobMessage (tenantId, runId, role USER|ASSISTANT|SYSTEM, content, authorUserId, createdAt). Yalnız kullanıcının
 * kendi yazdığı ve asistanın ürettiği metin saklanır; ekran/UI olayı/faaliyet izi YOK.
 * POST: kullanıcı mesajını kaydeder ve koşu canlıysa MEVCUT steer kanalına (SteeringMessage STEER) iletir — ajan döngüsü
 * bir sonraki turun başında tüketir (agent/claude.ts drainSteeringText). Sohbet ASLA araç/para/dış eylem tetiklemez:
 * ajanın eylemleri kendi mevcut onay/maliyet/kota kapılarından geçer; bu uç onay atlamaz, yeni LLM çağrısı açmaz.
 * Yetki (KASITLI, /steer ile aynı): yalnız router düzeyi authMiddleware; MEMBER yazabilir, aynı kiracının herkesi okur. rbac.ts'e yeni eylem yok.
 * GET en yeni mesaj başta döner (createdAt desc, id desc); istemci görüntülerken ters çevirir.
 * `queued`: mesaj steer kuyruğuna girdi (PENDING/RUNNING/PAUSED/WAITING_APPROVAL). PAUSED/WAITING_APPROVAL'da ajan çalışana dek
 * tüketilmez — "iletildi/okundu" DEĞİL. Bitmiş koşuda queued:false. Durum, yazım transaction'ı İÇİNDE yeniden okunur
 * (Prisma'da FOR UPDATE yok; okuma–yazma arası geçiş yarışı kabul edilmiş, yalnız kuyruk bayrağını etkiler).
 * Asistan yanıtı üretimi bu işte YOK (ENGEL/KARAR): ajan döngüsü yanıtlarını sohbete yazmaz; ayrı iş.
 */
import { z } from "zod";
import { AppError } from "../../middleware/error";
import { afterCursorWhere, decodeCursor, encodeCursor, LIST_ORDER, parseLimit } from "./list-cursor";

export const CHAT_DEFAULT_LIMIT = 50;
export const CHAT_MAX_LIMIT = 100;
export const CHAT_MAX_CONTENT = 4000;
/** Run başına saklanan en fazla mesaj (retention). Aşılırsa 409 chat_limit. */
export const CHAT_MAX_MESSAGES_PER_RUN = 500;
export const STEERABLE_STATUSES = ["PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL"] as const;

export const chatBodySchema = z.object({ content: z.string().trim().min(1).max(CHAT_MAX_CONTENT) }).strict();

/**
 * Ham sır/anahtar süzgeci: eşleşirse mesaj REDDEDİLİR (sessizce maskelemek anlamı bozar, sır yine de DB'ye girmesin).
 * Repoda yeniden kullanılabilir bir içerik-redact yardımcısı yok (lib/sentry yalnız olay yükü süzer) → kalıplar burada.
 * Hata yanıtı ve loglar içeriği YANKILAMAZ (sabit mesaj).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,                                   // OpenAI/Anthropic tarzı
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/,                        // Stripe
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,                                   // Stripe webhook
  /\bglpat-[A-Za-z0-9_-]{10,}/,                                // GitLab
  /\bnpm_[A-Za-z0-9]{20,}/,                                    // npm
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,                // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,                            // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                                      // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/,                                  // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,                       // Authorization başlığı
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                         // PEM
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i,                // URL içi kimlik (postgres://u:pass@h)
  /["']?\b(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?[^\s"',}]{8,}/i, // key=val ve "key": "val"
];
export function containsRawSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export interface ChatMessageDto { id: string; role: "USER" | "ASSISTANT" | "SYSTEM"; content: string; createdAt: string; mine: boolean }
export interface ChatPage { messages: ChatMessageDto[]; nextCursor: string | null }

/** authorUserId yanıta GİRMEZ (kimlik sızıntısı yok); yalnız `mine`. */
export function toChatDto(m: { id: string; role: "USER" | "ASSISTANT" | "SYSTEM"; content: string; createdAt: Date; authorUserId: string | null }, userId: string): ChatMessageDto {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(), mine: m.role === "USER" && m.authorUserId === userId };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadChat(db: any, input: { tenantId: string; userId: string; runId: string; limitRaw: unknown; cursorRaw: unknown }): Promise<ChatPage> {
  const limit = parseLimit(input.limitRaw, CHAT_DEFAULT_LIMIT, CHAT_MAX_LIMIT);
  if (limit === null) throw new AppError(400, `Invalid limit. Use an integer between 1 and ${CHAT_MAX_LIMIT}.`);
  const cursor = input.cursorRaw === undefined ? undefined : decodeCursor(input.cursorRaw);
  if (cursor === null) throw new AppError(400, "Invalid cursor.");
  const { tenantId, runId } = input;
  const run = await db.run.findFirst({ where: { id: runId, pipeline: { company: { tenantId } } }, select: { id: true } });
  if (!run) throw new AppError(404, "Run not found");
  const rows = await db.jobMessage.findMany({
    where: { AND: [{ tenantId, runId: run.id }, ...(cursor ? [afterCursorWhere(cursor)] : [])] },
    orderBy: LIST_ORDER,
    take: limit + 1,
    select: { id: true, role: true, content: true, createdAt: true, authorUserId: true },
  });
  const page = rows.slice(0, limit);
  return {
    messages: page.map((m: any) => toChatDto(m, input.userId)),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function postChat(db: any, input: { tenantId: string; userId: string; runId: string; body: unknown }): Promise<{ message: ChatMessageDto; queued: boolean }> {
  const parsed = chatBodySchema.safeParse(input.body);
  if (!parsed.success) throw new AppError(400, `content is required (1-${CHAT_MAX_CONTENT} characters), no other fields.`);
  const content = parsed.data.content;
  if (containsRawSecret(content)) throw new AppError(400, "Message looks like it contains a secret or API key. Remove it and send again.");
  const { tenantId, userId } = input;

  return db.$transaction(async (tx: any) => {
    const run = await tx.run.findFirst({ where: { id: input.runId, pipeline: { company: { tenantId } } }, select: { id: true, status: true } });
    if (!run) throw new AppError(404, "Run not found");
    const count = await tx.jobMessage.count({ where: { tenantId, runId: run.id } });
    if (count >= CHAT_MAX_MESSAGES_PER_RUN) throw new AppError(409, "Chat message limit reached for this job.", undefined, "chat_limit");
    const queued = (STEERABLE_STATUSES as readonly string[]).includes(run.status);
    const created = await tx.jobMessage.create({
      data: { tenantId, runId: run.id, role: "USER", content, authorUserId: userId },
    });
    if (queued) {
      await tx.steeringMessage.create({ data: { runId: run.id, kind: "STEER", content, targetAgentId: null, createdBy: userId } });
    }
    await tx.activityLog.create({
      data: { tenantId, actor: userId, action: "run.chat.send", resource: "run", resourceId: run.id, details: { messageId: created.id, queued } },
    });
    return { message: toChatDto(created, userId), queued };
  });
}
