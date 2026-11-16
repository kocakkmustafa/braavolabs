/** BRA-P0-06a-2 dilim 2 — model kipi ayar doğrulaması (saf). */
import { describe, expect, it } from "vitest";
import {
  applyCompanyModeSettings,
  parseAutoSelectionEnabled,
  parseCompanyModelMode,
  validateCompanyModeSettingsInput,
  validateModelModeConfigInput,
} from "../model-mode-settings";

const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

describe("validateModelModeConfigInput (ajan)", () => {
  it("geçerli tam yapı", () => {
    expect(validateModelModeConfigInput({
      cheapModel: "gpt-4o-mini", compareModels: ["a", "b", "c"], confidenceThreshold: 0.6, budgetUsdCap: 0.5,
    })).toEqual({ ok: true, value: { cheapModel: "gpt-4o-mini", compareModels: ["a", "b", "c"], confidenceThreshold: 0.6, budgetUsdCap: 0.5 } });
    expect(validateModelModeConfigInput({})).toEqual({ ok: true, value: {} });
  });
  it.each([null, [], "x", 5])("nesne olmayan girdi reddedilir: %j", (v) => {
    expect(err(validateModelModeConfigInput(v) as any)).toMatch(/object/);
  });
  it("bilinmeyen alan reddedilir (sessizce düşmez)", () => {
    expect(err(validateModelModeConfigInput({ apiKey: "sk-x" }) as any)).toMatch(/unknown field: apiKey/);
  });
  it("cheapModel: güvenli model kimliği biçimi", () => {
    for (const bad of ["", " x", "a b", "x".repeat(101), 5, "a;b", "<x>"]) {
      expect(validateModelModeConfigInput({ cheapModel: bad }).ok).toBe(false);
    }
    expect(validateModelModeConfigInput({ cheapModel: "meta-llama/llama-3.1:8b" }).ok).toBe(true);
  });
  it("compareModels: 2–3 tekil geçerli ad", () => {
    expect(err(validateModelModeConfigInput({ compareModels: ["a"] }) as any)).toMatch(/2-3/);
    expect(err(validateModelModeConfigInput({ compareModels: ["a", "b", "c", "d"] }) as any)).toMatch(/2-3/);
    expect(err(validateModelModeConfigInput({ compareModels: ["a", "a"] }) as any)).toMatch(/duplicates/);
    expect(validateModelModeConfigInput({ compareModels: "a" }).ok).toBe(false);
    expect(validateModelModeConfigInput({ compareModels: ["a", 1] }).ok).toBe(false);
  });
  it("confidenceThreshold 0..1 (sınırlar dahil); budgetUsdCap >0 ve ≤ üst sınır", () => {
    for (const v of [0, 0.7, 1]) expect(validateModelModeConfigInput({ confidenceThreshold: v }).ok).toBe(true);
    for (const v of [-0.01, 1.01, NaN, Infinity, "0.5"]) expect(validateModelModeConfigInput({ confidenceThreshold: v }).ok).toBe(false);
    for (const v of [0.01, 1_000_000]) expect(validateModelModeConfigInput({ budgetUsdCap: v }).ok).toBe(true);
    for (const v of [0, -1, 1_000_001, NaN, Infinity, "1"]) expect(validateModelModeConfigInput({ budgetUsdCap: v }).ok).toBe(false);
  });
});

describe("validateCompanyModeSettingsInput", () => {
  it("modelMode ve autoSelection", () => {
    expect(validateCompanyModeSettingsInput({ modelMode: "COMPARE" })).toEqual({ ok: true, value: { modelMode: "COMPARE" } });
    expect(validateCompanyModeSettingsInput({ autoSelection: { enabled: false } })).toEqual({ ok: true, value: { autoSelection: { enabled: false } } });
    expect(validateCompanyModeSettingsInput({ modelMode: null, autoSelection: null })).toEqual({ ok: true, value: { modelMode: null, autoSelection: null } });
  });
  it("geçersiz girdiler", () => {
    for (const body of [
      null, [], {}, { modelMode: "AUTO" }, { modelMode: "direct" }, { modelMode: 1 },
      { autoSelection: true }, { autoSelection: {} }, { autoSelection: { enabled: "yes" } },
      { autoSelection: { enabled: true, extra: 1 } }, { webhookSecret: "x" }, { modelMode: "DIRECT", niche: "x" },
    ]) {
      expect(validateCompanyModeSettingsInput(body).ok).toBe(false);
    }
  });
});

describe("okuma ve uygulama", () => {
  it("parse yardımcıları bozuk kayıtta null döner, fırlatmaz", () => {
    for (const c of [null, undefined, 5, [], {}, { modelMode: "x" }, { autoSelection: 1 }, { autoSelection: { enabled: "y" } }]) {
      expect(parseCompanyModelMode(c)).toBeNull();
      expect(parseAutoSelectionEnabled(c)).toBeNull();
    }
    expect(parseCompanyModelMode({ modelMode: "CASCADE" })).toBe("CASCADE");
    expect(parseAutoSelectionEnabled({ autoSelection: { enabled: false } })).toBe(false);
  });
  it("applyCompanyModeSettings diğer anahtarları korur, null siler, girdiyi değiştirmez", () => {
    const base = { niche: "x", webhookSecret: "keep", modelMode: "DIRECT" };
    const frozen = JSON.stringify(base);
    const a = applyCompanyModeSettings(base, { modelMode: "COMPARE", autoSelection: { enabled: true } });
    expect(a).toEqual({ niche: "x", webhookSecret: "keep", modelMode: "COMPARE", autoSelection: { enabled: true } });
    expect(JSON.stringify(base)).toBe(frozen);
    expect(applyCompanyModeSettings(a, { modelMode: null })).toEqual({ niche: "x", webhookSecret: "keep", autoSelection: { enabled: true } });
    expect(applyCompanyModeSettings(null, { autoSelection: { enabled: false } })).toEqual({ autoSelection: { enabled: false } });
    expect(applyCompanyModeSettings({ a: 1 }, {})).toEqual({ a: 1 });
  });
});
