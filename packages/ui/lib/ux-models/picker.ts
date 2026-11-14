/**
 * BRA-P0-06b — tek model seçici (saf mantık). Seçenekler `GET /research/compare/options` (şirketin yapılandırılmış sağlayıcı/model çiftleri);
 * rozet eşlemesi 06a'nın `modeBadges`ı (kaynak `GET /companies/:id/models` satırından, model kimliğiyle). COMPARE/DIRECT/CASCADE tanımı YOK.
 */
import type { CompareOptions } from "../compare";
import { modeBadges, type ModeBadge, type ModelRow } from "./models";

export interface PickerOption { key: string; provider: string; model: string; badges: ModeBadge[] }
export interface PickerAgent { id: string; name: string; model: string | null }
export type PickerTarget = { kind: "agent"; agentId: string } | { kind: "default" };

/** Seçenekler: sağlayıcı+model çifti tekil; rozet, aynı model kimliğini taşıyan genel bakış satırından gelir (satır yoksa rozet yok). */
export function buildPickerOptions(options: CompareOptions | null | undefined, rows: ModelRow[]): PickerOption[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  const out: PickerOption[] = [];
  for (const s of options?.selections ?? []) {
    const key = JSON.stringify([s.provider, s.model]);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byId.get(s.model);
    out.push({ key, provider: s.provider, model: s.model, badges: row ? modeBadges(row.source) : [] });
  }
  return out;
}

export function toPickerAgents(rows: unknown): PickerAgent[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string")
    .map((a) => ({
      id: a.id as string,
      name: typeof a.name === "string" && a.name ? a.name : (a.id as string),
      model: typeof a.model === "string" && a.model ? a.model : null,
    }));
}

/** Hedef + seçenek → hangi MEVCUT uç, hangi gövde. Ajan: PATCH {model}; varsayılan: PUT /settings/ai-config {provider, model} (anahtar gönderilmez). */
export function pickerRequest(target: PickerTarget, option: Pick<PickerOption, "provider" | "model">) {
  return target.kind === "agent"
    ? ({ endpoint: "agent" as const, agentId: target.agentId, body: { model: option.model } })
    : ({ endpoint: "default" as const, body: { provider: option.provider, model: option.model } });
}
