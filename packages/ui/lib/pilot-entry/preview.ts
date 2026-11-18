/**
 * BRA-P1-07-N3 — Pilot paketi önizleme özeti (saf, savunmacı). Ham JSON ekrana dökülmez: yalnız ad, sayılar ve bağlantı etiketleri.
 * Adlar `safeText` (maskele + kırp) kalıbından geçer. Şekil bozuksa `null` ("veri yok").
 */
import { safeText } from "../ux-kaput/mask";

export const PREVIEW_NAME_MAX = 80;
export const PREVIEW_CONNECTOR_MAX = 40;
export const PREVIEW_CONNECTOR_SHOWN = 10;

export interface PilotPreview {
  name: string;
  agents: number;
  pipelines: number;
  connectors: string[];
  /** Gösterilmeyen bağlantı etiketi sayısı. */
  connectorsHidden: number;
  records: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function toPilotPreview(raw: unknown): PilotPreview | null {
  if (!isObj(raw) || !isObj(raw.manifest) || !Array.isArray(raw.syntheticData)) return null;
  const m = raw.manifest;
  if (typeof m.name !== "string" || !m.name.trim() || !Array.isArray(m.agents) || !Array.isArray(m.pipelines)) return null;
  const requests = Array.isArray(m.connectorRequests) ? m.connectorRequests : [];
  const labels: string[] = [];
  for (const r of requests) {
    if (!isObj(r) || typeof r.provider !== "string" || !r.provider.trim()) continue;
    const label = safeText(r.provider, PREVIEW_CONNECTOR_MAX);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return {
    name: safeText(m.name, PREVIEW_NAME_MAX),
    agents: m.agents.length,
    pipelines: m.pipelines.length,
    connectors: labels.slice(0, PREVIEW_CONNECTOR_SHOWN),
    connectorsHidden: Math.max(0, labels.length - PREVIEW_CONNECTOR_SHOWN),
    records: raw.syntheticData.length,
  };
}
