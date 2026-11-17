/**
 * BRA-P1-08-N2 — bildirim DEEP LINK payload sözleşmesi (tek kaynak).
 *
 * Mobil çözümleyici: `mobile/lib/notifications.ts` `resolveNotificationRoute`
 * (kind -> rota; `id` yalnız `run` ve `company` için yola girer, deseni
 * `SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/`). Bu dosya yalnız mobilin zaten
 * tanıdığı türleri taşır; yeni rota uydurmaz.
 *
 * Payload'a yalnız tür + sürüm + kimlik girer. Başlık/gövde/kullanıcı metni,
 * PII ve sır ASLA data'ya konmaz (başlık/gövde mesajın kendi alanlarındadır).
 * Geriye dönük uyum: eski alan adları (`id`, `toolName`, `stopType`,
 * `companyId`) korunur; `v: 1` ek alandır.
 */
import { z } from "zod";

export const DEEP_LINK_VERSION = 1 as const;
export const DEEP_LINK_KINDS = ["approval", "risk", "draft", "run", "company"] as const;
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number];
/**
 * APNs 4 KB sınırının çok altında bir GÜVENLİK BANDI. Mevcut şemalarla en kötü durum
 * ≈250 bayt (approval: 64 id + 128 toolName); `refine` bugün erişilemez, ileride
 * alan eklenirse şişmeye karşı sigortadır.
 */
export const DEEP_LINK_MAX_BYTES = 1024;

/** Mobil `SAFE_ID_PATTERN` ile birebir. */
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const id = z.string().regex(ID_PATTERN);
/** Araç adı teknik tanımlayıcıdır (ör. `gmail.send_email`), serbest metin değil. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:\-/]{1,128}$/;
const toolName = z.string().regex(TOOL_NAME_PATTERN);
const stopType = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

const v = z.literal(DEEP_LINK_VERSION);

const approvalLink = z.object({ v, kind: z.literal("approval"), id: id.optional(), toolName: toolName.optional() }).strict();
const riskLink = z.object({ v, kind: z.literal("risk"), id: id.optional(), stopType: stopType.optional() }).strict();
const draftLink = z.object({ v, kind: z.literal("draft"), id: id.optional(), companyId: id.optional() }).strict();
const runLink = z.object({ v, kind: z.literal("run"), id: id.optional() }).strict();
const companyLink = z.object({ v, kind: z.literal("company"), id: id.optional() }).strict();

export const notificationDeepLinkSchema = z
  .discriminatedUnion("kind", [approvalLink, riskLink, draftLink, runLink, companyLink])
  .refine(link => Buffer.byteLength(JSON.stringify(link), "utf8") <= DEEP_LINK_MAX_BYTES, { message: "deep link payload too large" });

export type NotificationDeepLink = z.infer<typeof notificationDeepLinkSchema>;

/** Sıkı üretici: geçersizse ZodError fırlatır. `v` otomatik eklenir. */
export function buildDeepLink(input: { kind: DeepLinkKind } & Record<string, unknown>): NotificationDeepLink {
  return notificationDeepLinkSchema.parse({ ...input, v: DEEP_LINK_VERSION });
}

/** Sıkı çözümleyici: bilinmeyen alan/tür/sürüm/biçim -> null. */
export function parseDeepLink(data: unknown): NotificationDeepLink | null {
  const result = notificationDeepLinkSchema.safeParse(data);
  return result.success ? result.data : null;
}

const KNOWN_FIELDS: Record<DeepLinkKind, readonly string[]> = {
  approval: ["id", "toolName"],
  risk: ["id", "stopType"],
  draft: ["id", "companyId"],
  run: ["id"],
  company: ["id"],
};

/**
 * Gönderim yolu için hoşgörülü köprü: bilinen alanları süzer, geçersiz olanları
 * düşürür (bildirim hiçbir zaman bozuk kimlik yüzünden kaybolmaz; mobil
 * `id`siz bağlantıyı liste ekranına yönlendirir). Bilinmeyen/serbest alanlar
 * (kullanıcı metni dahil) payload'a ASLA taşınmaz. `dropped` alan adlarını döner.
 */
export function deepLinkDataFor(raw: { kind: string; [k: string]: unknown }): { data: NotificationDeepLink | { v: 1; kind: string }; dropped: string[] } {
  const kind = raw.kind as DeepLinkKind;
  if (!DEEP_LINK_KINDS.includes(kind)) return { data: { v: DEEP_LINK_VERSION, kind: raw.kind }, dropped: Object.keys(raw).filter(k => k !== "kind") };
  const candidate: Record<string, unknown> = { kind };
  const dropped: string[] = Object.keys(raw).filter(k => k !== "kind" && !KNOWN_FIELDS[kind].includes(k));
  for (const field of KNOWN_FIELDS[kind]) {
    if (raw[field] === undefined) continue;
    if (notificationDeepLinkSchema.safeParse({ v: DEEP_LINK_VERSION, kind, [field]: raw[field] }).success) candidate[field] = raw[field];
    else dropped.push(field);
  }
  return { data: buildDeepLink(candidate as { kind: DeepLinkKind }), dropped };
}
