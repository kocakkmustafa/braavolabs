/**
 * BRA-P0-06a-2 — Model kipleri (kurucu tanımı, 2026-11-15):
 *  - DIRECT  = seçilen tek model
 *  - CASCADE = ucuz modelle başla, yetmezse güçlüye geç
 *  - COMPARE = 2–3 model aynı işi yapar, sonuçlardan biri seçilir
 *
 * Bu dosya yalnız saf tip/çözümleme içerir (G/Ç yok). Kip ayarı Agent.modelMode,
 * Company.config.modelMode ve Company.config.autoSelection üzerinden gelir;
 * çalışma zamanı davranışı pipeline yürütücüsündedir.
 */
export const MODEL_MODES = ["DIRECT", "CASCADE", "COMPARE"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

export const COMPARE_MIN_MODELS = 2;
export const COMPARE_MAX_MODELS = 3;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export function isModelMode(value: unknown): value is ModelMode {
  return typeof value === "string" && (MODEL_MODES as readonly string[]).includes(value);
}

/** Agent.modelModeConfig — hepsi isteğe bağlı; eksikse çalışma zamanı DIRECT'e düşer. */
export interface ModelModeConfig {
  /** CASCADE: önce denenen ucuz model (güçlü model Agent.model'dir). */
  cheapModel?: string;
  /** COMPARE: aynı işi yapacak 2–3 model. */
  compareModels?: string[];
  /** CASCADE: bu güvenin altı güçlü modele yükseltir (0–1). */
  confidenceThreshold?: number;
  /** CASCADE/COMPARE: adım başına USD tavanı; aşılırsa yükseltme/ek aday durur. */
  budgetUsdCap?: number;
}

/**
 * Ham Json'u güvenli ModelModeConfig'e çevirir: bilinmeyen/geçersiz alan sessizce
 * düşer, uzunluk ve aralık sınırları uygulanır. Hiçbir zaman fırlatmaz.
 */
export function normalizeModelModeConfig(raw: unknown): ModelModeConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ModelModeConfig = {};
  const name = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 && t.length <= 200 ? t : null;
  };

  const cheap = name(r.cheapModel);
  if (cheap) out.cheapModel = cheap;

  if (Array.isArray(r.compareModels)) {
    const seen = new Set<string>();
    for (const item of r.compareModels) {
      const n = name(item);
      if (n && !seen.has(n)) seen.add(n);
      if (seen.size === COMPARE_MAX_MODELS) break;
    }
    if (seen.size > 0) out.compareModels = [...seen];
  }

  if (typeof r.confidenceThreshold === "number" && r.confidenceThreshold >= 0 && r.confidenceThreshold <= 1) {
    out.confidenceThreshold = r.confidenceThreshold;
  }
  if (typeof r.budgetUsdCap === "number" && Number.isFinite(r.budgetUsdCap) && r.budgetUsdCap > 0) {
    out.budgetUsdCap = r.budgetUsdCap;
  }
  return out;
}

/** COMPARE ancak 2–3 tekil adayla anlamlıdır; eksikse çalışma zamanı DIRECT'e düşer. */
export function isCompareConfigValid(config: ModelModeConfig): boolean {
  const n = config.compareModels?.length ?? 0;
  return n >= COMPARE_MIN_MODELS && n <= COMPARE_MAX_MODELS;
}

export type ModelModeSource = "agent" | "company" | "auto" | "default";

export interface EffectiveModelMode {
  mode: ModelMode;
  source: ModelModeSource;
}

/**
 * Etkin kip önceliği: ajan ayarı > şirket ayarı > autoSelection > DIRECT.
 * autoSelection açıkken ve hiçbir açık ayar yokken CASCADE istenir; ucuz model
 * çözülemezse çalışma zamanı DIRECT'e düşer ve bunu RunStep.modeDetail'e yazar.
 */
export function resolveEffectiveModelMode(input: {
  agentMode?: unknown;
  companyMode?: unknown;
  autoSelectionEnabled?: boolean | null;
}): EffectiveModelMode {
  if (isModelMode(input.agentMode)) return { mode: input.agentMode, source: "agent" };
  if (isModelMode(input.companyMode)) return { mode: input.companyMode, source: "company" };
  if (input.autoSelectionEnabled === true) return { mode: "CASCADE", source: "auto" };
  return { mode: "DIRECT", source: "default" };
}
