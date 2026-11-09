/**
 * BRA-UX-API-01 — GET /approvals için onay ayrıntıları (`details`).
 *
 * Saf, kapalı-şemalı türetme: ham `Approval.metadata` (+ type) girdi; çıktı yalnız
 * dört alan. Uydurma YOK: kaynak olmayan ya da beklenmeyen şekilli alan `null`.
 * Ham metadata asla olduğu gibi dönmez; gizli görünen anahtarlar (token/secret/key/
 * password/authorization …) hiçbir alana girmez; metinler ve diziler kırpılır.
 *
 * Kaynak tablosu (docs/yula-execution/DECISIONS.md, ADR-0003 "BRA-UX-API-01 notu"):
 *   risk         step kapısı: metadata.risk (low|medium|high; büyük/küçük harf duyarsız).
 *                Diğer tipler: kaynak yok → null (araç riskLevel'i metadata'ya yazılmıyor).
 *   permissions  metadata.tool (step kapısı) / metadata.toolName (araç kapısı);
 *                EXTERNAL_CONTROL: "toolName:ACTION". INPUT/HANDOFF: yetki istemez → null.
 *   dataTransfer SPEND araç kapısı: "toolName ← girdi alanları: a, b" (yalnız alan ADLARI,
 *                değer yok); EXTERNAL_CONTROL: bağlantı/hedef kimliği; HANDOFF: sağlayıcı/model.
 *                Step kapısı ve INPUT: kaynak yok → null.
 *   reversible   Hiçbir yerde kayıtlı değil → HER ZAMAN null.
 */

import type { ApprovalDetails, ApprovalRisk } from "@ai-company-os/core";

export type { ApprovalDetails, ApprovalRisk };

export const MAX_DETAIL_STRING = 200;
export const MAX_DETAIL_ITEMS = 10;

const SECRET_KEY = /token|secret|key|passw|authorization|credential|cookie|bearer|signature/i;

const NULL_DETAILS: ApprovalDetails = Object.freeze({
  risk: null,
  permissions: null,
  dataTransfer: null,
  reversible: null,
}) as ApprovalDetails;

function clamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > MAX_DETAIL_STRING ? t.slice(0, MAX_DETAIL_STRING - 1) + "…" : t;
}

/** Değer olarak da gizli görünen (anahtar adı gibi) metinleri döndürme. */
function safeText(v: unknown): string | null {
  const s = clamp(v);
  if (!s) return null;
  return SECRET_KEY.test(s) ? null : s;
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

function inputFieldNames(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>)
    .filter((k) => !SECRET_KEY.test(k))
    .map((k) => clamp(k))
    .filter((k): k is string => k !== null)
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
          permissions: list([safeText(m.tool)]),
          dataTransfer: null,
          reversible: null,
        };
      }
      const tool = safeText(m.toolName);
      const fields = inputFieldNames(m.input);
      return {
        risk: null,
        permissions: list([tool]),
        dataTransfer: tool && fields.length ? list([clamp(`${tool} ← girdi alanları: ${fields.join(", ")}`)]) : null,
        reversible: null,
      };
    }
    if (type === "EXTERNAL_CONTROL") {
      const tool = safeText(m.toolName);
      const action = typeof m.action === "string" && /^[A-Z_]{1,20}$/.test(m.action) ? m.action : null;
      const conn = safeText(m.connectionId);
      const target = safeText(m.targetId);
      return {
        risk: null,
        permissions: tool && action ? list([`${tool}:${action}`]) : list([tool]),
        dataTransfer: conn ? list([clamp(`${action ?? "eylem"} → bağlantı ${conn}${target ? `, hedef ${target}` : ""}`)]) : null,
        reversible: null,
      };
    }
    if (type === "HANDOFF") {
      const provider = safeText(m.suggestedProvider);
      const model = safeText(m.suggestedModel);
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
