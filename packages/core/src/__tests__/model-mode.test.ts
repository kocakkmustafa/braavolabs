import { describe, expect, it } from "vitest";
import {
  COMPARE_MAX_MODELS,
  isModelMode,
  normalizeModelModeConfig,
  resolveEffectiveModelMode,
} from "../types/model-mode";

describe("isModelMode", () => {
  it("yalnız üç kipi kabul eder", () => {
    for (const m of ["DIRECT", "CASCADE", "COMPARE"]) expect(isModelMode(m)).toBe(true);
    for (const m of ["direct", "AUTO", "", null, undefined, 1, {}]) expect(isModelMode(m)).toBe(false);
  });
});

describe("resolveEffectiveModelMode", () => {
  it("varsayılan DIRECT", () => {
    expect(resolveEffectiveModelMode({})).toEqual({ mode: "DIRECT", source: "default" });
  });
  it("ajan > şirket > autoSelection", () => {
    expect(resolveEffectiveModelMode({ agentMode: "COMPARE", companyMode: "CASCADE", autoSelectionEnabled: true })).toEqual({ mode: "COMPARE", source: "agent" });
    expect(resolveEffectiveModelMode({ companyMode: "CASCADE", autoSelectionEnabled: true })).toEqual({ mode: "CASCADE", source: "company" });
    expect(resolveEffectiveModelMode({ companyMode: "DIRECT", autoSelectionEnabled: true })).toEqual({ mode: "DIRECT", source: "company" });
  });
  it("autoSelection açık ve ayar yoksa CASCADE; kapalı/null/false ise DIRECT", () => {
    expect(resolveEffectiveModelMode({ autoSelectionEnabled: true })).toEqual({ mode: "CASCADE", source: "auto" });
    for (const v of [false, null, undefined]) {
      expect(resolveEffectiveModelMode({ autoSelectionEnabled: v })).toEqual({ mode: "DIRECT", source: "default" });
    }
  });
  it("geçersiz ham değerler miras zincirine düşer", () => {
    expect(resolveEffectiveModelMode({ agentMode: "bogus", companyMode: "COMPARE" })).toEqual({ mode: "COMPARE", source: "company" });
  });
});

describe("normalizeModelModeConfig", () => {
  it("geçersiz girdide boş nesne döner, fırlatmaz", () => {
    for (const v of [null, undefined, 5, "x", [], true]) expect(normalizeModelModeConfig(v)).toEqual({});
  });
  it("geçerli alanları korur", () => {
    expect(
      normalizeModelModeConfig({ cheapModel: " gpt-mini ", compareModels: ["a", "b"], confidenceThreshold: 0.5, budgetUsdCap: 0.25 }),
    ).toEqual({ cheapModel: "gpt-mini", compareModels: ["a", "b"], confidenceThreshold: 0.5, budgetUsdCap: 0.25 });
  });
  it("COMPARE adaylarını tekilleştirir ve en çok 3'e keser", () => {
    const out = normalizeModelModeConfig({ compareModels: ["a", "a", "b", "c", "d", "e"] });
    expect(out.compareModels).toEqual(["a", "b", "c"]);
    expect(out.compareModels!.length).toBeLessThanOrEqual(COMPARE_MAX_MODELS);
  });
  it("aralık dışı sayıları ve boş/aşırı uzun adları düşürür", () => {
    expect(normalizeModelModeConfig({ confidenceThreshold: 1.5, budgetUsdCap: 0, cheapModel: "" })).toEqual({});
    expect(normalizeModelModeConfig({ confidenceThreshold: -0.1, budgetUsdCap: Infinity, cheapModel: "x".repeat(201) })).toEqual({});
    expect(normalizeModelModeConfig({ compareModels: [1, null, "", "ok"] })).toEqual({ compareModels: ["ok"] });
  });
});
