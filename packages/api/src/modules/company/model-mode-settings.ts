/**
 * BRA-P0-06a-2 dilim 2 — model kipi ayarları (Company.config + Agent).
 *
 * Company.config.modelMode: "DIRECT" | "CASCADE" | "COMPARE" (şirket varsayılanı)
 * Company.config.autoSelection: { enabled: boolean } (açıkken ve açık kip yokken CASCADE istenir)
 * Agent.modelMode / Agent.modelModeConfig: ajan düzeyi (şirketi ezer).
 *
 * Saf yardımcılar; DB/IO yok. Girdi doğrulaması KATI (geçersizse hata döner, sessizce
 * düşürmez); okuma tarafı GÜVENLİ (bozuk kayıt -> null, asla throw etmez).
 */
import {
  COMPARE_MAX_MODELS,
  COMPARE_MIN_MODELS,
  isModelMode,
  type ModelMode,
  type ModelModeConfig,
} from "@ai-company-os/core";

export const MODE_CONFIG_KEY = "modelMode";
export const AUTO_SELECTION_CONFIG_KEY = "autoSelection";
export const MAX_MODE_BUDGET_USD = 1_000_000;

const SAFE_MODEL_NAME = /^[\w.:/-]{1,100}$/;
const CONFIG_KEYS = new Set(["cheapModel", "compareModels", "confidenceThreshold", "budgetUsdCap"]);

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Ajanın modelModeConfig'i (güvenilmeyen girdi). Bilinmeyen alan, geçersiz değer -> hata. */
export function validateModelModeConfigInput(raw: unknown): Validation<ModelModeConfig> {
  if (!isPlainObject(raw)) return { ok: false, error: "modelModeConfig must be an object or null" };
  for (const k of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(k)) return { ok: false, error: `modelModeConfig has unknown field: ${k}` };
  }
  const out: ModelModeConfig = {};
  if (raw.cheapModel !== undefined) {
    if (typeof raw.cheapModel !== "string" || !SAFE_MODEL_NAME.test(raw.cheapModel)) {
      return { ok: false, error: "cheapModel must be a model id (1-100 chars: letters, digits, . : / _ -)" };
    }
    out.cheapModel = raw.cheapModel;
  }
  if (raw.compareModels !== undefined) {
    const list = raw.compareModels;
    if (!Array.isArray(list) || list.some((m) => typeof m !== "string" || !SAFE_MODEL_NAME.test(m))) {
      return { ok: false, error: "compareModels must be an array of model ids" };
    }
    const unique = [...new Set(list as string[])];
    if (unique.length !== list.length) return { ok: false, error: "compareModels must not contain duplicates" };
    if (unique.length < COMPARE_MIN_MODELS || unique.length > COMPARE_MAX_MODELS) {
      return { ok: false, error: `compareModels needs ${COMPARE_MIN_MODELS}-${COMPARE_MAX_MODELS} models` };
    }
    out.compareModels = unique;
  }
  if (raw.confidenceThreshold !== undefined) {
    const v = raw.confidenceThreshold;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, error: "confidenceThreshold must be a number between 0 and 1" };
    }
    out.confidenceThreshold = v;
  }
  if (raw.budgetUsdCap !== undefined) {
    const v = raw.budgetUsdCap;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_MODE_BUDGET_USD) {
      return { ok: false, error: `budgetUsdCap must be a number > 0 and <= ${MAX_MODE_BUDGET_USD}` };
    }
    out.budgetUsdCap = v;
  }
  return { ok: true, value: out };
}

/** Şirket kip ayarı yamasının doğrulanmış hali: anahtar yoksa dokunulmaz; null = ayarı sil. */
export interface CompanyModeSettingsPatch {
  modelMode?: ModelMode | null;
  autoSelection?: { enabled: boolean } | null;
}

export function validateCompanyModeSettingsInput(raw: unknown): Validation<CompanyModeSettingsPatch> {
  if (!isPlainObject(raw)) return { ok: false, error: "body must be an object" };
  for (const k of Object.keys(raw)) {
    if (k !== MODE_CONFIG_KEY && k !== AUTO_SELECTION_CONFIG_KEY) {
      return { ok: false, error: `unknown field: ${k}` };
    }
  }
  const patch: CompanyModeSettingsPatch = {};
  if (MODE_CONFIG_KEY in raw) {
    const v = raw[MODE_CONFIG_KEY];
    if (v !== null && !isModelMode(v)) return { ok: false, error: "modelMode must be DIRECT, CASCADE, COMPARE or null" };
    patch.modelMode = v as ModelMode | null;
  }
  if (AUTO_SELECTION_CONFIG_KEY in raw) {
    const v = raw[AUTO_SELECTION_CONFIG_KEY];
    if (v !== null) {
      if (!isPlainObject(v) || Object.keys(v).some((k) => k !== "enabled") || typeof v.enabled !== "boolean") {
        return { ok: false, error: "autoSelection must be { enabled: boolean } or null" };
      }
      patch.autoSelection = { enabled: v.enabled };
    } else {
      patch.autoSelection = null;
    }
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "nothing to update: send modelMode and/or autoSelection" };
  return { ok: true, value: patch };
}

/** Company.config'ten şirket kipini okur; yok/bozuk -> null. Asla throw etmez. */
export function parseCompanyModelMode(config: unknown): ModelMode | null {
  if (!isPlainObject(config)) return null;
  const v = config[MODE_CONFIG_KEY];
  return isModelMode(v) ? v : null;
}

/** Company.config'ten autoSelection.enabled okur; yok/bozuk -> null (uydurma yok). */
export function parseAutoSelectionEnabled(config: unknown): boolean | null {
  if (!isPlainObject(config)) return null;
  const v = config[AUTO_SELECTION_CONFIG_KEY];
  return isPlainObject(v) && typeof v.enabled === "boolean" ? v.enabled : null;
}

/** config'e yamayı uygular (kopya döner); diğer anahtarlar korunur. */
export function applyCompanyModeSettings(
  config: unknown,
  patch: CompanyModeSettingsPatch,
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(config) ? { ...config } : {};
  if ("modelMode" in patch) {
    if (patch.modelMode === null || patch.modelMode === undefined) delete base[MODE_CONFIG_KEY];
    else base[MODE_CONFIG_KEY] = patch.modelMode;
  }
  if ("autoSelection" in patch) {
    if (patch.autoSelection === null || patch.autoSelection === undefined) delete base[AUTO_SELECTION_CONFIG_KEY];
    else base[AUTO_SELECTION_CONFIG_KEY] = patch.autoSelection;
  }
  return base;
}
