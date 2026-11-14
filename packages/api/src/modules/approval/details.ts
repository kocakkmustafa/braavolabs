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
 *   reversible   metadata.reversible YALNIZ boolean ise (BRA-UX-API-01c): para harcayan araç
 *                çağrısı false, external_control TRIGGER false / PAUSE-RESUME true. Kayıt yoksa
 *                (eski onaylar, adım kapısı, INPUT, HANDOFF, para dışı araçlar) null.
 */

import type { ApprovalDetails, ApprovalRisk } from "@ai-company-os/core";

export type { ApprovalDetails, ApprovalRisk };

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
 * Bilinen takas: önekin harf/rakama BİTİŞİK gömülmesi ("idsk_test_x") artık yakalanmaz.
 */
const ID_SECRET_ANYWHERE =
  /(?<![a-z0-9])(sk|pk|rk)[-_](live|test|ant|proj)|gh[pousr]_|xox[abprs]?-|AKIA[0-9A-Z]{8,}|whsec_|acct[-_]/i;
const ID_JWT = /(?<![A-Za-z0-9])eyJ/;
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
function leaksSecret(s: string): boolean {
  return (
    ID_SECRET_ANYWHERE.test(s) || ID_JWT.test(s) || ID_SECRET_WORD_START.test(s) || ID_LONG_HEX.test(s) || ID_LONG_BLOCK.test(s)
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

/** Biçim allowlist'ine uyan ve `leaksSecret` süzgecinden geçen değer; uymazsa null (ham değer asla çıkmaz). */
function matching(v: unknown, re: RegExp): string | null {
  if (typeof v !== "string" || !re.test(v) || SECRET_VALUE.test(v)) return null;
  if (leaksSecret(v)) return null;
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

export function deriveApprovalDetails(type: unknown, metadata: unknown): ApprovalDetails {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { ...NULL_DETAILS };
  const m = metadata as Record<string, unknown>;
  try {
    if (type === "SPEND") {
      if (m.gate === "step") {
        return {
          risk: asRisk(m.risk),
          permissions: list([matching(m.tool, TOOL_NAME)]),
          dataTransfer: null,
          reversible: null,
        };
      }
      const tool = matching(m.toolName, TOOL_NAME);
      const fields = inputFieldNames(m.input);
      return {
        risk: asRisk(m.riskLevel),
        permissions: list([tool]),
        dataTransfer: tool && fields.length ? list([clamp(`${tool} ← girdi alanları: ${fields.join(", ")}`)]) : null,
        reversible: asBool(m.reversible),
      };
    }
    if (type === "EXTERNAL_CONTROL") {
      const tool = matching(m.toolName, TOOL_NAME);
      const action = typeof m.action === "string" && /^[A-Z_]{1,20}$/.test(m.action) ? m.action : null;
      const conn = safeId(m.connectionId);
      const target = safeId(m.targetId);
      return {
        risk: asRisk(m.riskLevel),
        permissions: tool && action ? list([`${tool}:${action}`]) : list([tool]),
        dataTransfer: conn
          ? list([clamp(`${action ?? "eylem"} → bağlantı ${conn}${target ? `, hedef ${target}` : ""}`)])
          : null,
        reversible: asBool(m.reversible),
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
