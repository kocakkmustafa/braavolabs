import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import AgentsRoute from "../../app/agents/page";
import AgentsPage from "../../components/agents/AgentsPage";
import { ApiRequestError } from "../api";
import { UX_AGENTS_ENV, uxAgentsEnabled } from "./flag";
import { classifyAgentFailure, confirmDraft, descriptionProblem, mayBeSaved, parseConfirmResponse, parseDraftResponse, requestDraft, toAgentRows } from "./agents";

const UI = join(__dirname, "..", "..");
const DRAFT = { name: "Satış Özetçisi", role: "analyst", systemPrompt: "Her sabah satış e-postalarını özetler.", tools: ["gmail"] };
const DRAFT_RES = { draft: DRAFT, droppedTools: ["slack_x"], provider: "anthropic", model: "claude-x", tokens: { input: 1, output: 2 } };
const deps = (over: Partial<{ draft: any; confirm: any }> = {}) => ({ draft: vi.fn().mockResolvedValue(DRAFT_RES), confirm: vi.fn().mockResolvedValue({ agent: { id: "a1", ...DRAFT }, droppedTools: ["slack_x"] }), ...over });

describe("bayrak", () => {
  it("varsayılan KAPALI; yalnız 1/true açar", () => {
    expect(uxAgentsEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on"]) expect(uxAgentsEnabled({ [UX_AGENTS_ENV]: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxAgentsEnabled({ [UX_AGENTS_ENV]: v })).toBe(true);
    expect(uxAgentsEnabled({ NEXT_PUBLIC_UX_MODELS: "1" })).toBe(false);
  });
  it("KAPALI regresyon: /agents rotası notFound (önceki 404 davranışı), açıkken yeni sayfa; istek anında okunur", () => {
    const prev = process.env[UX_AGENTS_ENV];
    try {
      delete process.env[UX_AGENTS_ENV];
      expect(() => AgentsRoute()).toThrow(/404/);
      process.env[UX_AGENTS_ENV] = "0";
      expect(() => AgentsRoute()).toThrow();
      process.env[UX_AGENTS_ENV] = "1";
      expect(AgentsRoute().type).toBe(AgentsPage);
    } finally { if (prev === undefined) delete process.env[UX_AGENTS_ENV]; else process.env[UX_AGENTS_ENV] = prev; }
    expect(readFileSync(join(UI, "app/agents/page.tsx"), "utf8")).toMatch(/export const dynamic = "force-dynamic"/);
    expect(readFileSync(join(UI, "lib/ux-agents/flag.ts"), "utf8")).not.toMatch(/process\.env\.NEXT_PUBLIC_UX_AGENTS/);
  });
});

describe("AgentDraft akışı: taslak kayıt yazmaz, confirm yalnız onayla", () => {
  it("requestDraft yalnız draft ucunu çağırır; confirm çağrılmaz; taslak durumuna geçer", async () => {
    const d = deps();
    const s = await requestDraft(d, "  Her sabah satış e-postalarını özetle  ");
    expect(d.draft).toHaveBeenCalledWith("Her sabah satış e-postalarını özetle");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(s).toMatchObject({ phase: "draft", result: { draft: DRAFT, droppedTools: ["slack_x"], provider: "anthropic", model: "claude-x" } });
  });
  it("kısa/uzun açıklama sunucuya gitmez", async () => {
    const d = deps();
    expect(await requestDraft(d, "kısa")).toEqual({ phase: "idle" });
    expect(d.draft).not.toHaveBeenCalled();
    expect(descriptionProblem("a".repeat(9))).toBe("tooShort");
    expect(descriptionProblem("a".repeat(10))).toBeNull();
    expect(descriptionProblem("a".repeat(4001))).toBe("tooLong");
  });
  it("confirmDraft taslağı {draft} olarak aynen gönderir ve created döner", async () => {
    const d = deps();
    const s = await confirmDraft(d, await requestDraft(d, "Her sabah satış e-postalarını özetle"));
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.confirm).toHaveBeenCalledWith(DRAFT);
    expect(s).toMatchObject({ phase: "created", created: { id: "a1", name: "Satış Özetçisi", droppedTools: ["slack_x"] } });
  });
  it("taslak olmayan durumdan (idle/drafting/created) confirm çağrılmaz", async () => {
    const d = deps();
    for (const st of [{ phase: "idle" }, { phase: "drafting", description: "x" }, { phase: "created", created: { id: null, name: "a", role: "r", tools: [], droppedTools: [] } }] as const) {
      expect(await confirmDraft(d, st as any)).toBe(st);
    }
    expect(d.confirm).not.toHaveBeenCalled();
  });
  it("confirm hatasında taslak korunur ve yeniden denenebilir; draft ucu tekrar çağrılmaz", async () => {
    const d = deps({ confirm: vi.fn().mockRejectedValueOnce(new ApiRequestError(429, "x")).mockResolvedValueOnce({ agent: { id: "a2", ...DRAFT }, droppedTools: [] }) });
    const draft = await requestDraft(d, "Her sabah satış e-postalarını özetle");
    const err = await confirmDraft(d, draft);
    expect(err).toMatchObject({ phase: "error", stage: "confirm", kind: "rateLimit", result: { draft: DRAFT } });
    expect(await confirmDraft(d, err)).toMatchObject({ phase: "created" });
    expect(d.draft).toHaveBeenCalledTimes(1);
  });
});

describe("droppedTools", () => {
  it("taslak yanıtında korunur; bozuk liste yanıtı reddedilir", () => {
    expect(parseDraftResponse(DRAFT_RES)?.droppedTools).toEqual(["slack_x"]);
    expect(parseDraftResponse({ ...DRAFT_RES, droppedTools: undefined })?.droppedTools).toEqual([]);
    expect(parseDraftResponse({ ...DRAFT_RES, droppedTools: "x" })).toBeNull();
    expect(parseDraftResponse({ draft: { ...DRAFT, tools: [1] } })).toBeNull();
    expect(parseDraftResponse(null)).toBeNull();
    expect(parseConfirmResponse({ agent: {}, droppedTools: [] })).toBeNull();
  });
  it("bileşen droppedTools'u data-testid ile gösterir ve araç adlarını LTR sarar", () => {
    const src = readFileSync(join(UI, "components/agents/AgentsPage.tsx"), "utf8");
    expect(src).toContain('data-testid="agents-dropped"');
    expect(src).toContain('dir="ltr"');
    expect(src).toMatch(/result\.droppedTools\.map/);
  });
});

describe("hata durumları açık metin", () => {
  const e = (status: number, message = "x") => new ApiRequestError(status, message);
  it("sınıflar", () => {
    expect(classifyAgentFailure(e(401))).toBe("session");
    expect(classifyAgentFailure(e(402))).toBe("payment");
    expect(classifyAgentFailure(e(403))).toBe("forbidden");
    expect(classifyAgentFailure(e(404))).toBe("notFound");
    expect(classifyAgentFailure(e(429))).toBe("rateLimit");
    expect(classifyAgentFailure(e(504))).toBe("timeout");
    expect(classifyAgentFailure(e(400, "Configure an AI provider in Settings"))).toBe("noProvider");
    expect(classifyAgentFailure(e(400, "role must be snake_case"))).toBe("badDraft");
    expect(classifyAgentFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyAgentFailure(e(500))).toBe("generic");
    expect(classifyAgentFailure(undefined)).toBe("generic");
    expect(mayBeSaved("network") && mayBeSaved("timeout") && !mayBeSaved("rateLimit")).toBe(true);
  });
  it("taslak hatası: error/draft, kayıt yok; 402 ve 429 ayrı", async () => {
    for (const [st, kind] of [[402, "payment"], [429, "rateLimit"]] as const) {
      const d = deps({ draft: vi.fn().mockRejectedValue(e(st)) });
      expect(await requestDraft(d, "Her sabah satış e-postalarını özetle")).toMatchObject({ phase: "error", stage: "draft", kind });
      expect(d.confirm).not.toHaveBeenCalled();
    }
  });
  it("bozuk sunucu yanıtı kaydedildi gibi gösterilmez", async () => {
    const d = deps({ draft: vi.fn().mockResolvedValue({ foo: 1 }) });
    expect(await requestDraft(d, "Her sabah satış e-postalarını özetle")).toMatchObject({ kind: "badResponse" });
    const d2 = deps({ confirm: vi.fn().mockResolvedValue({}) });
    expect(await confirmDraft(d2, await requestDraft(d2, "Her sabah satış e-postalarını özetle"))).toMatchObject({ phase: "error", stage: "confirm", kind: "badResponse" });
  });
});

describe("AgentsPage: belirsiz hata, yükleniyor, meşgul", () => {
  const src = readFileSync(join(UI, "components/agents/AgentsPage.tsx"), "utf8");
  it("mayBeSaved iken 'Yeniden dene' yok, 'Listeyi yenile' var; liste yenilenir", () => {
    expect(src).toMatch(/result && !mayBeSaved\(state\.kind\) &&[^\n]*create\(\)/);
    expect(src).toMatch(/mayBeSaved\(state\.kind\) && <div><button[^\n]*agents-refresh[^\n]*loadRows\(\)[^\n]*refreshList/);
    expect(src).toContain('data-testid="agents-already"');
  });
  it("yükleniyor role=status, şirket seçici busy iken disabled, tekrarlı araç anahtarı benzersiz, iç içe main yok", () => {
    expect(src).toMatch(/rows === null && !rowsFailed && <div role="status" data-testid="agents-loading"/);
    expect(src).toMatch(/data-testid="agents-company" value=\{companyId\} disabled=\{busy\}/);
    expect(src).not.toMatch(/<span key=\{x\}>/);
    expect(src).not.toMatch(/<main\b/);
  });
  it("402 metni faturalamaya yönlendirmez (15 dil); refreshList/loading var", () => {
    const dir = join(UI, "messages");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.agents;
      expect(m.error.payment, f).toMatch(/402/);
      expect(m.error.payment, f).not.toMatch(/Billing|Faturalama|Fatturazione|Facturación|Faturamento|Abrechnung|Penagihan|Rozliczenia|Facturation|請求|账单|결제|बिलिंग|الفوترة/);
      expect(m.refreshList).toMatch(/\S/);
      expect(m.loading).toMatch(/\S/);
    }
  });
});

describe("toAgentRows: yalnız API alanları, durum uydurulmaz", () => {
  it("map", () => {
    expect(toAgentRows([{ id: "a", name: "Ad", role: "r", tools: ["t"], autonomy: "BALANCED" }, { id: "b" }, null, { name: "idsiz" }])).toEqual([
      { id: "a", name: "Ad", role: "r", tools: ["t"], status: null, autonomy: "BALANCED" },
      { id: "b", name: "b", role: "", tools: [], status: null, autonomy: null },
    ]);
    expect(toAgentRows("x")).toEqual([]);
  });
});

describe("api: uçlar var olan compose/draft ve compose/confirm", () => {
  const api = readFileSync(join(UI, "lib/api.ts"), "utf8");
  it("yollar ve gövde", () => {
    expect(api).toMatch(/agents\/compose\/draft`[^)]*body: JSON\.stringify\(\{ description \}\)/);
    expect(api).toMatch(/agents\/compose\/confirm`[^)]*body: JSON\.stringify\(\{ draft \}\)/);
  });
});

describe("i18n: app.agents 15 dilde aynı anahtar ve yer tutucu kümesi", () => {
  const dir = join(UI, "messages");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const flat = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const get = (m: any, p: string) => p.split(".").reduce((a: any, k) => a?.[k], m);
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8")).app.agents;
  it("15 dosya", () => expect(files).toHaveLength(15));
  it("bileşen anahtarları en'de var", () => {
    const src = readFileSync(join(UI, "components/agents/AgentsPage.tsx"), "utf8");
    const keys = [...new Set([...src.matchAll(/\bat\("([A-Za-z.]+)"/g)].map((m) => m[1]))];
    for (const k of keys) expect(typeof get(en, k), k).toBe("string");
    for (const k of Object.keys(en.error)) expect(typeof en.error[k]).toBe("string");
  });
  for (const f of files) it(`${f}: en ile birebir, boş yok, yer tutucular aynı`, () => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.agents;
    expect(flat(m).sort()).toEqual(flat(en).sort());
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of flat(m)) { const v = get(m, k); expect(v, `${f}:${k}`).toMatch(/\S/); expect(ph(v), `${f}:${k}`).toBe(ph(get(en, k))); }
  });
});

describe("bozuk /agents bağlantısı: rota artık gerçek, bayrak dışı kaynakta /agents bağlantısı yok", () => {
  it("app/agents/page.tsx var; app/components'ta '/agents' href/Link yok (bayrak KAPALI iken 404 olurdu)", () => {
    expect(existsSync(resolve(UI, "app/agents/page.tsx"))).toBe(true);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const hits = ["app", "components"].flatMap((d) => walk(join(UI, d))).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .filter((f) => /["'`]\/agents(?:["'`/?#])/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
