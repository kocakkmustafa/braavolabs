import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { ModelsOverview } from "@ai-company-os/core";
import { uxModelsEnabled } from "./flag";
import { retryFocusTarget } from "./focus";
import { COST_DISPLAY_FLOOR, isBelowCostPrecision, modeBadges, parseCostUsd, toModelRow, toOverviewView } from "./models";

const overview = (over: Partial<ModelsOverview> = {}): ModelsOverview => ({
  autoSelection: { enabled: null },
  models: [],
  generatedAt: "2026-11-13T10:00:00.000Z",
  costWindow: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-13T10:00:00.000Z" },
  ...over,
});

describe("bayrak", () => {
  it("varsayılan kapalı; yalnız 1/true açar (boşluk ve büyük harf duyarsız)", () => {
    expect(uxModelsEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on"]) expect(uxModelsEnabled({ NEXT_PUBLIC_UX_MODELS: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxModelsEnabled({ NEXT_PUBLIC_UX_MODELS: v })).toBe(true);
  });
});

describe("parseCostUsd (Decimal METİN)", () => {
  it("geçerli metin sayıya, diğer her şey null", () => {
    expect(parseCostUsd("12.500000")).toBe(12.5);
    expect(parseCostUsd("0.000000")).toBe(0);
    expect(parseCostUsd(" 3 ")).toBe(3);
    for (const v of ["", " ", "abc", "-1", "1e3", "12,50", ".5", "1.", "0x10", "Infinity", "NaN", null, undefined, {}, [], true, NaN, Infinity, -0.5]) expect(parseCostUsd(v)).toBeNull();
    expect(parseCostUsd(0)).toBe(0);
    expect(parseCostUsd(2.5)).toBe(2.5);
  });
});

describe("isBelowCostPrecision: sıfırdan büyük ama 4 ondalığın altı '$0.00' görünmez", () => {
  it("sınırlar", () => {
    expect(COST_DISPLAY_FLOOR).toBe(0.0001);
    expect(isBelowCostPrecision(0)).toBe(false);
    expect(isBelowCostPrecision(parseCostUsd("0.000012") as number)).toBe(true);
    expect(isBelowCostPrecision(0.0001)).toBe(false);
    expect(isBelowCostPrecision(1.2345)).toBe(false);
  });
});

describe("toModelRow — API-02 null alanları 'unknown'/null kalır, değer uydurulmaz", () => {
  it("tüm alanlar null → kaynak/kapsam/kip unknown, maliyet ve koşu null", () => {
    const r = toModelRow({ id: "m1", provider: null, source: null, access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null });
    expect(r).toEqual({ id: "m1", provider: null, displayName: null, source: "unknown", scope: "unknown", mode: "unknown", cost: null, runCount: null });
  });
  it("dolu alanlar okunur; sıfır maliyet 0 (bilinmiyor DEĞİL)", () => {
    const r = toModelRow({ id: "claude-x", provider: "anthropic", source: "byok", access: { scope: "company", mode: "read_write" }, costThisMonthUsd: "0.000000", runCountThisMonth: 0 });
    expect(r).toMatchObject({ source: "byok", scope: "company", mode: "read_write", cost: 0, runCount: 0, provider: "anthropic" });
  });
  it("bilinmeyen sıralı değerler ve bozuk sayılar unknown/null olur", () => {
    const r = toModelRow({ id: "m", provider: "  ", source: "cloud" as any, access: { scope: "tenant" as any, mode: "write" as any }, costThisMonthUsd: "12,5", runCountThisMonth: -1 as any });
    expect(r).toMatchObject({ provider: null, source: "unknown", scope: "unknown", mode: "unknown", cost: null, runCount: null });
  });
  it("access eksik olsa da çökmez", () => {
    expect(() => toModelRow({ id: "m", provider: null, source: null, costThisMonthUsd: null, runCountThisMonth: null } as any)).not.toThrow();
  });
});

describe("modeBadges: yalnız kaynağa bağlı (BYOK/LOCAL); autoSelection etkilemez", () => {
  const cases: [Parameters<typeof modeBadges>[0], string[]][] = [["byok", ["byok"]], ["local", ["local"]], ["platform", []], ["unknown", []]];
  for (const [src, want] of cases) it(`${src} → [${want}]`, () => expect(modeBadges(src)).toEqual(want));
  it("autoSelection true/false/null görünümde de satır rozetini değiştirmez", () => {
    for (const auto of [true, false, null]) {
      const v = toOverviewView(overview({ autoSelection: { enabled: auto }, models: [{ id: "a", provider: null, source: "byok", access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null }] }));
      expect(modeBadges(v.rows[0].source)).toEqual(["byok"]);
    }
  });
});

describe("toOverviewView", () => {
  it("otomatik seçim null → null; boolean korunur", () => {
    expect(toOverviewView(overview()).autoSelection).toBeNull();
    expect(toOverviewView(overview({ autoSelection: { enabled: true } })).autoSelection).toBe(true);
    expect(toOverviewView(overview({ autoSelection: { enabled: false } })).autoSelection).toBe(false);
  });
  it("bozuk/eksik yanıt çökertmez; kimliksiz model atılır", () => {
    expect(toOverviewView(null).rows).toEqual([]);
    expect(toOverviewView({ models: "x" } as any).rows).toEqual([]);
    const v = toOverviewView(overview({ models: [{ id: "", provider: null, source: null, access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null }, null as any, { id: "ok", provider: null, source: null, access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null }] }));
    expect(v.rows.map((r) => r.id)).toEqual(["ok"]);
  });
  it("zaman damgaları taşınır", () => {
    const v = toOverviewView(overview());
    expect(v.generatedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(v.costFrom).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("i18n: app.models 15 dilde aynı anahtar kümesi, boş değer yok", () => {
  const dir = join(__dirname, "../../messages");
  const flat = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("tam 15 dil dosyası var", () => expect(files).toHaveLength(15));
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8")).app.models;
  it("en anahtarları bileşenin kullandığı anahtarları kapsar", () => {
    const keys = flat(en);
    for (const k of ["title", "autoLabel", "autoOn", "autoOff", "unknown", "source.byok", "source.local", "source.platform", "source.unknown", "scope.company", "scope.workspace", "scope.agent", "mode.read", "mode.read_write", "costNote", "costSince", "updatedAt", "runCount", "badge.byok", "badge.local", "links.own.title", "links.integrations.body"]) expect(keys).toContain(k);
  });
  for (const f of files) it(`${f}: app.models en ile birebir`, () => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.models;
    expect(flat(m).sort()).toEqual(flat(en).sort());
    for (const k of flat(m)) expect(k.split(".").reduce((a: any, p) => a[p], m)).toMatch(/\S/);
  });
  it("yer tutucular her dilde aynı ({count}, {from}, {time})", () => {
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.models;
      for (const k of ["live", "runCount", "costSince", "updatedAt"]) {
        const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        expect(ph(m[k]), `${f}:${k}`).toBe(ph(en[k]));
      }
    }
  });
});

describe("BRA-UX-05h-b: ayırıcılar çeviri anahtarında", () => {
  const dir = join(__dirname, "../../messages");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const get = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")).app.models;
  for (const f of files) it(`${f}: labelSep ve pairSep tanımlı`, () => {
    expect(get(f).labelSep).toMatch(/[:：]/);
    expect(get(f).pairSep).toMatch(/\S/);
  });
  it("ja/zh tam genişlikli iki nokta, fr boşluklu iki nokta, en ': ' ve ' · '", () => {
    expect(get("ja.json").labelSep).toBe("：");
    expect(get("zh-Hans.json").labelSep).toBe("：");
    expect(get("fr.json").labelSep).toBe(" : ");
    expect(get("en.json")).toMatchObject({ labelSep: ": ", pairSep: " · " });
  });
  it("bileşende sabit ayırıcı kalmadı", () => {
    const src = readFileSync(join(__dirname, "../../components/models/ModelsOverviewPage.tsx"), "utf8");
    expect(src).not.toMatch(/\)\}: /);
    expect(src).not.toMatch(/\} · /);
    expect(src).not.toContain("</strong> ·");
    expect(src).not.toContain('mt("runs")}: ');
    expect(src).toContain('mt("labelSep")');
    expect(src).toContain('mt("pairSep")');
  });
});

describe("BRA-UX-05h-b: ja/zh tam genişlikli ayırıcı, RTL ok, şirket değişiminde odak", () => {
  const dir = join(__dirname, "../../messages");
  const src = readFileSync(join(__dirname, "../../components/models/ModelsOverviewPage.tsx"), "utf8");
  for (const f of ["ja.json", "zh-Hans.json"]) it(`${f}: app.models değerlerinde ASCII ': ' yok`, () => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.models;
    const vals = (o: any): string[] => Object.values(o).flatMap((v) => (v && typeof v === "object" ? vals(v) : [String(v)]));
    for (const v of vals(m)) expect(v, `${f}: ${v}`).not.toMatch(/: /);
    expect(m.runCount).toMatch(/：\{count\}/);
  });
  it("ar'da yönlendirme oku ters (‹), diğer dillerde ›", () => {
    expect(src).toContain('{locale === "ar" ? "‹" : "›"}');
  });
  it("şirket değişiminde bekleyen odak iptal edilir (odak çalınmaz)", () => {
    expect(src).toContain('onChange={(e) => { retryPending.current = false; setLoad(');
    // saf yardımcı: bayrak sıfırlanınca hiçbir hedef yok
    expect(retryFocusTarget(false, "ready")).toBeNull();
    expect(retryFocusTarget(false, "error")).toBeNull();
  });
});

describe("BRA-UX-05h-b: Tekrar dene sonrası odak", () => {
  it("retryFocusTarget", () => {
    for (const st of ["idle", "loading", "ready", "error"] as const) expect(retryFocusTarget(false, st)).toBeNull();
    expect(retryFocusTarget(true, "ready")).toBe("results");
    expect(retryFocusTarget(true, "error")).toBe("retry");
    expect(retryFocusTarget(true, "loading")).toBeNull();
    expect(retryFocusTarget(true, "idle")).toBeNull();
  });
  it("bileşen: odaklanabilir sonuç kabı ve tıklamada odak", () => {
    const src = readFileSync(join(__dirname, "../../components/models/ModelsOverviewPage.tsx"), "utf8");
    expect(src).toContain('data-testid="models-results"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain("resultsRef.current?.focus(); if (companiesFailed) loadCompanies(); else { retryPending.current = true; loadModels(); }");
  });
});

import { buildPickerOptions, pickerRequest, toPickerAgents } from "./picker";

describe("BRA-P0-06b: model seçici mantığı", () => {
  const opts = { companyId: "c1", maxCandidates: 3 as const, selections: [
    { provider: "ANTHROPIC", model: "claude-sonnet-5", reasoningEfforts: [] },
    { provider: "OLLAMA", model: "mini-model", reasoningEfforts: [] },
    { provider: "OPENAI", model: "gpt-zero", reasoningEfforts: [] },
    { provider: "OPENAI", model: "gpt-zero", reasoningEfforts: [] },
  ] };
  const rows = ["byok", "local", "platform"].map((source, i) => toModelRow({ id: ["claude-sonnet-5", "mini-model", "gpt-zero"][i], provider: null, source, access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null } as never));

  it("rozetler 06a eşlemesinden; platform/satırsız rozetsiz; yinelenen çift tekilleşir", () => {
    const o = buildPickerOptions(opts, rows);
    expect(o.map((x) => x.badges)).toEqual([["byok"], ["local"], []]);
    expect(buildPickerOptions(opts, []).every((x) => x.badges.length === 0)).toBe(true);
    expect(buildPickerOptions(null, rows)).toEqual([]);
  });
  it("ajan hedefi → PATCH {model}; varsayılan → PUT {provider, model} (anahtar yok)", () => {
    expect(pickerRequest({ kind: "agent", agentId: "a1" }, { provider: "OPENAI", model: "gpt-zero" })).toEqual({ endpoint: "agent", agentId: "a1", body: { model: "gpt-zero" } });
    const d = pickerRequest({ kind: "default" }, { provider: "OPENAI", model: "gpt-zero" });
    expect(d).toEqual({ endpoint: "default", body: { provider: "OPENAI", model: "gpt-zero" } });
    expect("apiKey" in d.body).toBe(false);
  });
  it("ajan listesi bozuk girdiyle çökmez; model yoksa null", () => {
    expect(toPickerAgents(null)).toEqual([]);
    expect(toPickerAgents([{ id: "a1", name: "X", model: "m" }, { id: "a2" }, null, { name: "y" }])).toEqual([{ id: "a1", name: "X", model: "m" }, { id: "a2", name: "a2", model: null }]);
  });
});
