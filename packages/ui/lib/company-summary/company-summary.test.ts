import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const state = vi.hoisted(() => ({ revision: 1, tenantId: "t" as string | null, token: "tok" as string | null }));
vi.mock("../store", () => ({
  captureAuthSession: () => ({ ...state }), isAuthSessionCurrent: (o: typeof state) => o.revision === state.revision && o.tenantId === state.tenantId,
  useAppStore: { getState: () => ({ ...state }) },
}));
import { api } from "../api";
import { parseCompanySummary, toMoney } from "./parse";
import { toBudgetView, toCompanySummaryView } from "./view";

const full = {
  companyId: "c1", agents: 3, pipelines: 2, buckets: { working: 1, needs_approval: 2, done: 5, stuck: 0 }, pendingApprovals: 2,
  monthCostUsd: "12.340000", budget: { limitUsd: 100, spentUsd: 12.34, remainingUsd: 87.66, usedPct: 12.34, state: "ok" },
};

describe("parseCompanySummary", () => {
  it("tam yanıt: alanlar korunur, para metin", () => {
    const d = parseCompanySummary(full)!;
    expect(d.agents).toBe(3);
    expect(d.buckets).toEqual({ working: 1, needs_approval: 2, stuck: 0, done: 5 });
    expect(d.monthCostUsd).toBe("12.340000");
    expect(d.budget).toEqual({ state: "ok", limitUsd: "100", spentUsd: "12.34", remainingUsd: "87.66", usedPct: 12.34 });
  });
  it("gerçek 0 korunur, eksik/sayı-dışı null (0 uydurulmaz)", () => {
    const d = parseCompanySummary({ agents: "3", pipelines: -1, buckets: { working: 0, stuck: 1.5, done: NaN }, pendingApprovals: null, monthCostUsd: "abc" })!;
    expect(d.agents).toBeNull();
    expect(d.pipelines).toBeNull();
    expect(d.buckets).toEqual({ working: 0, needs_approval: null, stuck: null, done: null });
    expect(d.pendingApprovals).toBeNull();
    expect(d.monthCostUsd).toBeNull();
    expect(d.budget.state).toBe("none");
  });
  it.each([null, undefined, 5, "x", [], true])("bozuk gövde %j → null", (raw) => expect(parseCompanySummary(raw)).toBeNull());
  it("buckets/budget bozuksa çökmez; bilinmeyen bütçe durumu none", () => {
    const d = parseCompanySummary({ buckets: [1], budget: { state: "weird", limitUsd: 5, spentUsd: 9 } })!;
    expect(d.buckets.working).toBeNull();
    expect(d.budget).toEqual({ state: "none", limitUsd: null, spentUsd: null, remainingUsd: null, usedPct: null });
  });
  it("toMoney: Decimal metin/sonlu sayı; üstel, virgül, negatif (izin yoksa) null", () => {
    expect(toMoney("0.000001")).toBe("0.000001");
    expect(toMoney(5)).toBe("5");
    for (const v of ["1e3", "1,5", "", "-1", Infinity, NaN, {}, null]) expect(toMoney(v)).toBeNull();
    expect(toMoney(-12.5, true)).toBe("-12.5");
  });
});

describe("view eşleme", () => {
  it("null sayılar null kalır (arayüz 'Bilinmiyor' yazar), 0 olmaz", () => {
    const v = toCompanySummaryView(parseCompanySummary({})!);
    expect(v.agents).toBeNull();
    expect(v.pendingApprovals).toBeNull();
    expect(v.monthCostUsd).toBeNull();
    expect(v.buckets.every((b) => b.count === null)).toBe(true);
    expect(v.buckets.map((b) => b.key)).toEqual(["working", "needs_approval", "stuck", "done"]);
  });
  const b = (state: string, extra: object = {}) => toBudgetView(parseCompanySummary({ budget: { state, limitUsd: 100, spentUsd: 50, remainingUsd: 50, usedPct: 50, ...extra } })!.budget);
  it("4 bütçe durumu → ton/etiket/çubuk", () => {
    expect(toBudgetView(parseCompanySummary({ budget: { state: "none" } })!.budget)).toMatchObject({ tone: "muted", labelKey: "none", barPct: null });
    expect(b("ok")).toMatchObject({ tone: "cyan", labelKey: "ok", barPct: 50 });
    expect(b("warn", { usedPct: 85 })).toMatchObject({ tone: "amber", labelKey: "warn", barPct: 85 });
    expect(b("over", { usedPct: 130 })).toMatchObject({ tone: "red", labelKey: "over", barPct: 100, usedPct: 130 });
  });
  it("limit 0 + harcama: over, yüzde yok, çubuk dolu", () => {
    const v = toBudgetView(parseCompanySummary({ budget: { state: "over", limitUsd: 0, spentUsd: 3, remainingUsd: -3, usedPct: null } })!.budget);
    expect(v).toMatchObject({ state: "over", usedPct: null, barPct: 100, remainingUsd: "-3", limitUsd: "0" });
  });
  it("limit 0 + harcama 0: ok, yüzde yok, çubuk yok", () => {
    const v = toBudgetView(parseCompanySummary({ budget: { state: "ok", limitUsd: 0, spentUsd: 0, remainingUsd: 0, usedPct: null } })!.budget);
    expect(v).toMatchObject({ state: "ok", usedPct: null, barPct: null });
  });
  it("çubuk 0..100'e kırpılır", () => {
    expect(b("warn", { usedPct: 999 }).barPct).toBe(100);
  });
});

describe("api.getCompanySummary", () => {
  const fetchSpy = vi.fn();
  const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
  beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); });
  afterEach(() => vi.unstubAllGlobals());
  it("kodlanmış şirket kimliğiyle /summary çağırır ve ayrıştırır", async () => {
    fetchSpy.mockResolvedValue(response(full));
    const d = await api.getCompanySummary("tok", "c/1?x");
    expect(fetchSpy.mock.calls[0][0]).toContain("/companies/c%2F1%3Fx/summary");
    expect(d?.pendingApprovals).toBe(2);
  });
  it("bozuk gövde → null; HTTP hatası → fırlatır", async () => {
    fetchSpy.mockResolvedValue(response("<html>"));
    await expect(api.getCompanySummary("tok", "c1")).resolves.toBeNull();
    fetchSpy.mockResolvedValue(response({ error: "x" }, 500));
    await expect(api.getCompanySummary("tok", "c1")).rejects.toThrow();
  });
});

describe("i18n anahtarları", () => {
  const dir = fileURLToPath(new URL("../../messages/", import.meta.url));
  const flat = (o: unknown, p = "", r: string[] = []): string[] => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, r); else r.push(p); return r; };
  const ref = flat(JSON.parse(readFileSync(dir + "en.json", "utf8")).app.companySummary).sort();
  it.each(["en", "tr", "es", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"])("%s tüm anahtarlara sahip", (code) => {
    const m = JSON.parse(readFileSync(`${dir}${code}.json`, "utf8")).app.companySummary;
    expect(flat(m).sort()).toEqual(ref);
    expect(ref.length).toBe(24);
  });
});
