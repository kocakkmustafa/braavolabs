/**
 * BRA-UX-API-01 — GET /approvals için onay ayrıntıları (`details`).
 *
 * Saf, kapalı-şemalı türetme: ham `Approval.metadata` (+ type) girdi; çıktı yalnız
 * dört alan. Uydurma YOK: kaynak olmayan ya da beklenmeyen şekilli alan `null`.
 * Ham metadata asla olduğu gibi dönmez. Serbest metin alanları (araç adı, kimlik,
 * anahtar adı) biçim ALLOWLIST'inden geçer; uymayan parça atlanır/null olur, ham
 * değer yanıta girmez. Gizli görünen anahtar adları ve sk-/ghp_/JWT biçimleri
 * hiçbir alana girmez; metinler ve diziler kırpılır.
 *
 * Kaynak tablosu (docs/yula-execution/DECISIONS.md, ADR-0003 "BRA-UX-API-01 notu"):
 *   risk         step kapısı: metadata.risk (low|medium|high; büyük/küçük harf duyarsız).
 *                Araç kapısı (SPEND) ve EXTERNAL_CONTROL: metadata.riskLevel (BRA-UX-API-01c,
 *                tool-executor onay oluştururken registry meta'sından yazar). Eski onaylarda
 *                alan yok → null. INPUT/HANDOFF: kaynak yok → null.
 *   permissions  metadata.tool (step kapısı) / metadata.toolName (araç kapısı);
 *                EXTERNAL_CONTROL: "toolName:ACTION". INPUT/HANDOFF: yetki istemez → null.
 *   dataTransfer SPEND araç kapısı: "toolName ← girdi alanları: a, b" (yalnız güvenli alan
 *                ADLARI, değer yok); EXTERNAL_CONTROL: bağlantı/hedef kimliği (kimlik
 *                allowlist'i); HANDOFF: sağlayıcı/model. Step kapısı ve INPUT: null.
 *   dataTransferStructured (BRA-UX-API-07) dataTransfer ile aynı kaynak/süzgeç, metinsiz: yalnız
 *                araç/alan/kimlik ADLARI (yön ayrı alan değil, `kind`'dan çıkar; external_control
 *                için ham `action` ayrıca var). Boyut: fields ≤ MAX_DETAIL_ITEMS (10), her ad
 *                ≤ 41 karakter, kimlik/araç/sağlayıcı ≤ 64 → toplam sınırlı. dataTransfer null ise alan hiç yok.
 *   reversible   metadata.reversible YALNIZ boolean ise (BRA-UX-API-01c): para harcayan araç
 *                çağrısı false, external_control TRIGGER false / PAUSE-RESUME true. Kayıt yoksa
 *                (eski onaylar, adım kapısı, INPUT, HANDOFF, para dışı araçlar) null.
 */

import type { ApprovalDataTransfer, ApprovalDetails, ApprovalRisk } from "@ai-company-os/core";

export type { ApprovalDataTransfer, ApprovalDetails, ApprovalRisk };

export const MAX_DETAIL_STRING = 200;
export const MAX_DETAIL_ITEMS = 10;
/** Anahtar sayısı üst sınırı: yalnız ilk N anahtar incelenir. */
export const MAX_KEYS_SCANNED = 50;

/** Gizli-ad regex'i: YALNIZ serbest anahtar adları için (araç adı/kimlik allowlist'iyle süzülür). */
const SECRET_NAME =
  /token|secret|passw|pwd|auth|jwt|session|otp|pin|private|credential|cookie|bearer|signature|api[-_]?key|(^|[-_.])key($|[-_.])|key$/i;
/** Anahtar/değer gibi görünen gizli biçimler (sk-…, ghp_…, xox…, AKIA…, JWT). */
const SECRET_VALUE = /^(sk|pk|rk)[-_]|^gh[pousr]_|^xox|^AKIA|^eyJ/i;
/** LLM girdisinden gelen alan adı biçimi. */
const FIELD_NAME = /^[A-Za-z_][\w.-]{0,40}$/;
/**
 * Kimlik biçimi (connectionId/targetId). BRA-UX-API-01b: `:` YOK (`user:pass`, `acct:…`
 * biçimleri bu alandan geçemez); gerçek kimlikler (cuid/uuid/slug) iki nokta içermez.
 */
const ID_SAFE = /^[\w.-]{1,64}$/;
/**
 * Gizli önekler (BRA-UX-API-01d: sol sınırlı). `sk|pk|rk` + `-`/`_` + live/test/ant/proj yalnız
 * KELİME BAŞINDA aranır: sol komşu harf/rakam OLMAMALI (`_`, `.`, `-`, başlangıç sınır sayılır) →
 * "task-test-1", "risk-test" yanlış pozitif olmaz; "id_sk_test_x", "my.sk-live-x" yakalanır.
 * `eyJ` (JWT başlığı) büyük/küçük harf DUYARLI ve sol sınırlı ("keyjob" geçer). `ghp_`-ailesi, `xox*`,
 * `AKIA…`, `whsec_`, `acct[-_]` her konumda (ayırt edici, yanlış pozitif riski düşük).
 * Harf/rakama BİTİŞİK gömülü önek ("idsk_test_x") bu desenle değil, aşağıdaki gövde uzunluklu
 * `ID_SECRET_EMBEDDED` ile (≥20 karakter gövde) yakalanır; kısa gövdeli gömülü geçer (takas).
 */
const ID_SECRET_ANYWHERE =
  /(?<![a-z0-9])(sk|pk|rk)[-_](live|test|ant|proj)|gh[pousr]_|xox[abprs]?-|AKIA[0-9A-Z]{8,}|whsec_|acct[-_]/i;
/**
 * Sol sınırsız, gövde uzunluklu ek desen (gömülü "idsk_test_4eC39…" sızıntısı): önek + ≥20 karakter
 * gövde. Kısa gövde ("task-test-1", "flask_test", "disk_test_configuration") geçer. ant/proj gövdesi
 * `-`/`_` içerebilir (sk-ant-api03-…). Takas: gömülü + KISA gövdeli ("idsk_test_abc123") geçer.
 */
const ID_SECRET_EMBEDDED = /(sk|pk|rk)[-_](live|test)[-_][A-Za-z0-9]{20,}|(sk|pk|rk)[-_](ant|proj)[-_][A-Za-z0-9_-]{20,}/i;
const ID_JWT = /(?<![A-Za-z0-9])eyJ/;
/**
 * BRA-UX-API-01e: Google API anahtarı (`AIza` + 35 karakter = 39) ve GitLab PAT (`glpat-` + 20 = 26)
 * ID_LONG_BLOCK (≥40) sınırının altında kaldığı için hiçbir süzgece takılmıyordu. Büyük/küçük harf
 * DUYARLI (gerçek önekler sabit) ve ≥20 karakter gövdeli: "AIzaWord", "glpat-notes" geçer.
 */
const ID_VENDOR_KEY = /AIza[0-9A-Za-z_-]{20,}|glpat-[0-9A-Za-z_-]{20,}/;
/**
 * Genel `sk|pk|rk` + `-`/`_`: kelime başında ve `_` sınır SAYILMAZ ("task_pk_1" geçer). Tireli biçim
 * (`sk-…`) `_` sonrasında da yakalanır ("x_sk-abc"). Takas: "task_pk-1" reddedilir.
 */
const ID_SECRET_WORD_START = /(?<![a-z0-9_])(sk|pk|rk)[-_]|(?<![a-z0-9])(sk|pk|rk)-/i;
/**
 * Uzun hex (≥32 hane, her konumda) ve ≥40 karakterlik blok: anahtar/özet/token gibi görünür.
 * Bilinen takas: `.`/`-` ile bölünmüş hex (ör. 16+16 hane) bu desenlere takılmaz (uuid de geçmeli).
 */
const ID_LONG_HEX = /[0-9a-f]{32,}/i;
const ID_LONG_BLOCK = /[A-Za-z0-9_-]{40,}/;

/** Önek/hex/blok süzgeci: kimlik, araç adı, sağlayıcı/model ve alan adı için ortak. */
export function leaksSecret(s: string): boolean {
  return (
    ID_SECRET_ANYWHERE.test(s) || ID_SECRET_EMBEDDED.test(s) || ID_JWT.test(s) || ID_VENDOR_KEY.test(s) || ID_SECRET_WORD_START.test(s) || ID_LONG_HEX.test(s) || ID_LONG_BLOCK.test(s)
  );
}

/** `ID_SAFE` (+ `matching` içindeki ortak sızıntı süzgeci); uymazsa null. */
function safeId(v: unknown): string | null {
  return matching(v, ID_SAFE);
}
/** Araç adı biçimi (registry adı / pipeline config tool). */
const TOOL_NAME = /^[A-Za-z][\w.:-]{0,63}$/;
/** Sağlayıcı/model adı biçimi (gpt-4o, claude-3.5, vendor/model). */
const PROVIDER_NAME = /^[\w.:/-]{1,64}$/;

/** SANDBOX_ESCAPE metadata re-validation (target is already masked at write time). */
const ESCAPE_KIND = /^[a-z]+\.[a-z_]+$/;
const ESCAPE_REASON = /^[a-z0-9_-]{1,64}$/;
// Same forbidden set as sandbox-escape.ts FORBIDDEN_CHARS (+ U+2028/2029 line separators): the write
// side already rejects/masks secrets, so display only refuses control/bidi/invisible characters and
// keeps ordinary filenames (spaces, Unicode) visible to the approver.
// eslint-disable-next-line no-control-regex
const ESCAPE_TARGET_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const ESCAPE_TARGET = { test: (s: string) => s.length >= 1 && s.length <= 256 && !ESCAPE_TARGET_FORBIDDEN.test(s) };

const NULL_DETAILS: ApprovalDetails = Object.freeze({
  risk: null,
  permissions: null,
  dataTransfer: null,
  reversible: null,
}) as ApprovalDetails;

function clamp(v: string): string {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > MAX_DETAIL_STRING ? t.slice(0, MAX_DETAIL_STRING - 1) + "…" : t;
}

/**
 * BRA-UX-API-07k: `:` içeren araç/sağlayıcı/model değerlerinde kimlik biçimi reddi (DAR sezgi).
 * Reddedilir YALNIZ: (a) `://` içeren (URL/userinfo), (c) SOL parça (ilk `:` öncesi) açıkça
 * parola/kimlik-bilgisi sözcüğü (tam eşleşme, /i): password|passwd|pass|pwd|token|secret|apikey|api_key|bearer|basic.
 * (`@` kuralı yok: PROVIDER_NAME/TOOL_NAME allowlist'i `@` zaten geçirmez → ölü kod.)
 * Meşru etiketler asla düşmez: `llama3:8b`, `phi3:medium`, `deepseek/deepseek-r1:free`, `x:nitro`,
 * `auth:login`, `user:create`, `ns:send_email`, `host:5000/ns/model:tag`.
 * BİLİNEN YAPISAL SINIR: `bob:hunter2`, `u:p4ss1` gibi etiket-benzeri değerler `llama3:8b` ile ayırt
 * edilemez → GEÇER. Asıl savunma yukarı akışta (allowlist + `leaksSecret`); bu bir sızıntı-azaltmadır,
 * tam çözüm değil. `leaksSecret`'e EKLENMEZ (mcp-auth başlık değerlerinde `:` meşru).
 */
const CRED_LEFT = /^(password|passwd|pass|pwd|token|secret|apikey|api_key|bearer|basic)$/i;
export function credentialShaped(v: string): boolean {
  if (!v.includes(":")) return false;
  if (v.includes("://")) return true;
  return CRED_LEFT.test(v.slice(0, v.indexOf(":")));
}

/** Biçim allowlist'ine uyan ve `leaksSecret` süzgecinden geçen değer; uymazsa null (ham değer asla çıkmaz). */
function matching(v: unknown, re: RegExp): string | null {
  if (typeof v !== "string" || !re.test(v) || SECRET_VALUE.test(v)) return null;
  if (leaksSecret(v) || credentialShaped(v)) return null;
  return v;
}

function list(items: Array<string | null>): string[] | null {
  const out = items.filter((x): x is string => typeof x === "string").slice(0, MAX_DETAIL_ITEMS);
  return out.length ? out : null;
}

function asRisk(v: unknown): ApprovalRisk | null {
  if (typeof v !== "string") return null;
  const r = v.trim().toLowerCase();
  return r === "low" || r === "medium" || r === "high" ? r : null;
}

/** Yalnız gerçek boolean; "true"/1 gibi şekiller null (uydurma yok). */
function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function inputFieldNames(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>)
    .slice(0, MAX_KEYS_SCANNED)
    .filter((k) => FIELD_NAME.test(k) && !SECRET_NAME.test(k) && !SECRET_VALUE.test(k) && !leaksSecret(k))
    .slice(0, MAX_DETAIL_ITEMS);
}

/**
 * Yalnız RİSK türetimi (tek kaynak; deriveApprovalDetails da bunu kullanır). Regex/süzgeç çalıştırmaz.
 * SPEND+step kapısı: metadata.risk · SPEND/EXTERNAL_CONTROL: metadata.riskLevel · diğer: null.
 */
export function deriveApprovalRisk(type: unknown, metadata: unknown): ApprovalRisk | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (type === "SPEND") return m.gate === "step" ? asRisk(m.risk) : asRisk(m.riskLevel);
  if (type === "EXTERNAL_CONTROL") return asRisk(m.riskLevel);
  return null;
}

export function deriveApprovalDetails(type: unknown, metadata: unknown): ApprovalDetails {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { ...NULL_DETAILS };
  const m = metadata as Record<string, unknown>;
  try {
    if (type === "SPEND") {
      if (m.gate === "step") {
        return {
          risk: deriveApprovalRisk(type, metadata),
          permissions: list([matching(m.tool, TOOL_NAME)]),
          dataTransfer: null,
          reversible: null,
        };
      }
      const tool = matching(m.toolName, TOOL_NAME);
      const fields = inputFieldNames(m.input);
      return {
        risk: deriveApprovalRisk(type, metadata),
        permissions: list([tool]),
        dataTransfer: tool && fields.length ? list([clamp(`${tool} ← girdi alanları: ${fields.join(", ")}`)]) : null,
        reversible: asBool(m.reversible),
        ...(tool && fields.length ? { dataTransferStructured: { kind: "input_fields" as const, tool, fields } } : {}),
      };
    }
    if (type === "EXTERNAL_CONTROL") {
      const tool = matching(m.toolName, TOOL_NAME);
      const action = typeof m.action === "string" && /^[A-Z_]{1,20}$/.test(m.action) ? m.action : null;
      const conn = safeId(m.connectionId);
      const target = safeId(m.targetId);
      return {
        risk: deriveApprovalRisk(type, metadata),
        permissions: tool && action ? list([`${tool}:${action}`]) : list([tool]),
        dataTransfer: conn
          ? list([clamp(`${action ?? "eylem"} → bağlantı ${conn}${target ? `, hedef ${target}` : ""}`)])
          : null,
        reversible: asBool(m.reversible),
        ...(conn
          ? {
              dataTransferStructured: {
                kind: "external_control" as const,
                ...(action ? { action } : {}),
                connectionId: conn,
                ...(target ? { targetId: target } : {}),
              },
            }
          : {}),
      };
    }
    if (type === "SANDBOX_ESCAPE") {
      // BRA-P2-02c: the displayed action comes from metadata only (kind + masked target + code),
      // re-validated here; the agent-written `description` is never the source.
      const escapeKind = typeof m.kind === "string" && ESCAPE_KIND.test(m.kind) ? m.kind : null;
      const target = typeof m.target === "string" && ESCAPE_TARGET.test(m.target) ? m.target : null;
      const reasonCode = typeof m.reasonCode === "string" && ESCAPE_REASON.test(m.reasonCode) ? m.reasonCode : null;
      return {
        risk: null,
        permissions: list([escapeKind]),
        dataTransfer: escapeKind && target && reasonCode ? list([clamp(`${escapeKind} → ${target} (${reasonCode})`)]) : null,
        reversible: null,
        ...(escapeKind && target && reasonCode
          ? { dataTransferStructured: { kind: "sandbox_escape" as const, escapeKind, target, reasonCode } }
          : {}),
      };
    }
    if (type === "HANDOFF") {
      const provider = matching(m.suggestedProvider, PROVIDER_NAME);
      const model = matching(m.suggestedModel, PROVIDER_NAME);
      return {
        risk: null,
        permissions: null,
        dataTransfer: provider ? list([clamp(`koşu → ${provider}${model ? ` / ${model}` : ""}`)]) : null,
        reversible: null,
        ...(provider
          ? { dataTransferStructured: { kind: "handoff" as const, provider, ...(model ? { model } : {}) } }
          : {}),
      };
    }
  } catch {
    /* beklenmeyen şekil → boş */
  }
  return { ...NULL_DETAILS };
}

/** Satıra `details` ekler (ham metadata'dan; projectApprovalRow'dan ÖNCE çağrılmalı). */
export function withApprovalDetails<T extends { type?: unknown; metadata: unknown }>(row: T): T & { details: ApprovalDetails } {
  return { ...row, details: deriveApprovalDetails(row.type, row.metadata) };
}
