/**
 * BRA-UX-API-02 — GET /companies/:id/models: kiracı kapsamı (where şekli + bellek içi sahte ile
 * gerçek ayrım), null alanlar, Decimal metin, UTC ay penceresi, sızıntı yokluğu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

type Co = { id: string; tenantId: string };
type Ag = { id: string; companyId: string; model: string };
type Cfg = { tenantId: string; provider: string; model: string; isDefault: boolean; encryptedApiKey: string | null; baseUrl?: string };
type Step = { agentId: string | null; runId: string; costUsd: unknown; createdAt: Date };

const db = vi.hoisted(() => ({
  companies: [] as Co[],
  agents: [] as Ag[],
  configs: [] as Cfg[],
  steps: [] as Step[],
  calls: { agent: [] as any[], config: [] as any[], company: [] as any[], raw: [] as any[] },
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        db.calls.company.push(a);
        return db.companies.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null;
      },
    },
    agent: {
      findMany: async (a: any) => {
        db.calls.agent.push(a);
        const w = a.where;
        return db.agents.filter(
          (x) =>
            x.companyId === w.companyId &&
            db.companies.find((c) => c.id === x.companyId)?.tenantId === w.company?.tenantId,
        );
      },
    },
    userAIConfig: {
      findMany: async (a: any) => {
        db.calls.config.push(a);
        return db.configs.filter((c) => c.tenantId === a.where.tenantId);
      },
    },
    // Etiketli şablon: (strings, companyId, tenantId, from, to) -> SQL'in yaptığı birleştirme/süzme/gruplama.
    $queryRaw: async (strings: TemplateStringsArray, ...v: any[]) => {
      db.calls.raw.push({ sql: strings.join("?"), values: v });
      const [companyId, tenantId, from, to] = v as [string, string, Date, Date];
      const acc = new Map<string, { cost: bigint | null; runs: Set<string> }>();
      for (const s of db.steps) {
        const ag = db.agents.find((a) => a.id === s.agentId);
        if (!ag || ag.companyId !== companyId) continue;
        if (db.companies.find((c) => c.id === ag.companyId)?.tenantId !== tenantId) continue;
        if (s.createdAt < from || s.createdAt > to) continue;
        const e = acc.get(ag.id) ?? { cost: null, runs: new Set<string>() };
        e.runs.add(s.runId);
        if (s.costUsd !== null) e.cost = (e.cost ?? 0n) + BigInt(Math.round(Number(String(s.costUsd)) * 1e6));
        acc.set(ag.id, e);
      }
      return [...acc.entries()].map(([agent_id, e]) => ({
        agent_id,
        cost: e.cost === null ? null : dec(Number(e.cost) / 1e6),
        runs: BigInt(e.runs.size),
      }));
    },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", async () => {
  const actual = await vi.importActual<typeof import("../../../middleware/auth")>("../../../middleware/auth");
  const mocked = (_q: unknown, _s: unknown, n: () => void) => n();
  return { ...actual, authMiddleware: mocked, realAuth: actual.authMiddleware };
});
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { companyRouter } from "../router";
import { buildModelsOverview, monthStartUtc, toMicro, microToText, isSecretLike } from "../models-overview";
import * as authMod from "../../../middleware/auth";

function dec(n: number | string) {
  const num = Number(n);
  return { toFixed: (d: number) => num.toFixed(d), toString: () => String(n) };
}
function routeLayer(router: Router) {
  return (router as any).stack.find((l: any) => l.route?.path === "/:id/models" && l.route.methods.get);
}
const layer = routeLayer(companyRouter);
const h = layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;

async function invoke(id = "co-1", tenantId = "t-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params: { id }, auth: { tenantId, userId: "u", role: "member" } }, res, (e?: any) => { err = e; });
  return { res, err };
}
const NOW = () => new Date();
const ag = (id: string, model: string, companyId = "co-1"): Ag => ({ id, companyId, model });
const step = (agentId: string | null, runId: string, costUsd: unknown, createdAt = NOW()): Step => ({ agentId, runId, costUsd, createdAt });

beforeEach(() => {
  vi.useRealTimers();
  db.companies = [{ id: "co-1", tenantId: "t-1" }, { id: "co-2", tenantId: "t-1" }, { id: "co-B", tenantId: "t-B" }];
  db.agents = []; db.configs = []; db.steps = [];
  db.calls.agent = []; db.calls.config = []; db.calls.company = []; db.calls.raw = [];
});

describe("kiracı / çalışma alanı kapsamı", () => {
  it("başka kiracının şirketi -> 404, veri sorgulanmaz; where {id, tenantId} kilitli", async () => {
    const { err } = await invoke("co-B", "t-1");
    expect(err.statusCode).toBe(404);
    expect(db.calls.company[0].where).toEqual({ id: "co-B", tenantId: "t-1" });
    expect(db.calls.agent).toHaveLength(0);
    expect(db.calls.raw).toHaveLength(0);
  });

  it("aynı kiracının başka şirketi (çalışma alanı) yalnız kendi ajanlarını görür; yokluk 404", async () => {
    db.agents = [ag("a1", "gpt-4o", "co-1"), ag("a2", "gemini-1.5-pro", "co-2")];
    const { res } = await invoke("co-2");
    expect(res.body.models.map((m: any) => m.id)).toEqual(["gemini-1.5-pro"]);
    const { err } = await invoke("co-yok");
    expect(err.statusCode).toBe(404);
  });

  it("where şekli: ajan sorgusu {companyId, company:{tenantId}}; ham sorgu company+tenant parametreleri; config tenantId", async () => {
    await invoke();
    expect(db.calls.agent[0].where).toEqual({ companyId: "co-1", company: { tenantId: "t-1" } });
    expect(db.calls.config[0].where).toEqual({ tenantId: "t-1" });
    expect(db.calls.raw[0].values.slice(0, 2)).toEqual(["co-1", "t-1"]);
    expect(db.calls.raw[0].sql).toMatch(/c\.tenant_id = \?/);
    expect(db.calls.raw[0].sql).toMatch(/GROUP BY rs\.agent_id/);
  });

  it("gerçek ayrım: B kiracısı ajan/adım/sağlayıcı satırları A yanıtına girmez", async () => {
    db.agents = [ag("a1", "gpt-4o"), ag("aB", "claude-sonnet-5-5", "co-B"), ag("aB2", "gpt-4o", "co-B")];
    db.steps = [step("a1", "r1", "1.5"), step("aB", "rB", "99"), step("aB2", "rB2", "77")];
    db.configs = [{ tenantId: "t-B", provider: "OPENAI", model: "gpt-4o", isDefault: true, encryptedApiKey: "enc:B" }];
    const { res } = await invoke("co-1", "t-1");
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0]).toMatchObject({ id: "gpt-4o", costThisMonthUsd: "1.500000", runCountThisMonth: 1, source: null });
    expect(JSON.stringify(res.body)).not.toMatch(/99|77|claude-sonnet/);
    // Kiracı B kendi yanıtında kendi verisini görür
    const b = await invoke("co-B", "t-B");
    expect(b.res.body.models.map((m: any) => m.id).sort()).toEqual(["claude-sonnet-5-5", "gpt-4o"]);
    expect(b.res.body.models.find((m: any) => m.id === "gpt-4o")).toMatchObject({ costThisMonthUsd: "77.000000", source: "byok" });
  });

  it("buildModelsOverview doğrudan: başka kiracı (t-B, co-1) -> boş; ajan where ve SQL parametreleri tenant'ı bağımsız taşır", async () => {
    // NOT: sahte SQL'i ÇALIŞTIRMAZ; yalnız parametre sırasını (companyId, tenantId, from, to) bekleyip
    // süzmeyi JS'te taklit eder. SQL metnindeki tenant koşulu ayrıca metin eşleşmesiyle denetlenir.
    db.agents = [ag("a1", "gpt-4o")];
    db.steps = [step("a1", "r1", "3")];
    const out = await buildModelsOverview("t-B", "co-1");
    expect(out.models).toEqual([]);
    expect(db.calls.agent[0].where).toEqual({ companyId: "co-1", company: { tenantId: "t-B" } });
    expect(db.calls.raw[0].values.slice(0, 2)).toEqual(["co-1", "t-B"]);
    expect(db.calls.raw[0].sql).toMatch(/c\.company_id|a\.company_id = \?/);
    expect(db.calls.raw[0].sql).toMatch(/c\.tenant_id = \?/);
    const ok = await buildModelsOverview("t-1", "co-1");
    expect(ok.models).toHaveLength(1);
  });

  it("aynı kimlik iki bulut kataloğunda: anahtarlı satır seçilir (ilki anahtarsız, ikincisi anahtarlı -> byok)", async () => {
    db.agents = [ag("a1", "glm-4.7")];
    db.configs = [
      { tenantId: "t-1", provider: "CEREBRAS", model: "x", isDefault: true, encryptedApiKey: null },
      { tenantId: "t-1", provider: "ZHIPU", model: "x", isDefault: false, encryptedApiKey: "enc:K" },
    ];
    const { res } = await invoke();
    expect(res.body.models[0]).toMatchObject({ provider: "ZHIPU", source: "byok" });
    db.configs[1].encryptedApiKey = null;
    expect((await invoke()).res.body.models[0]).toMatchObject({ provider: "CEREBRAS", source: null });
  });

  it("kimliksiz istek -> 401 (gerçek middleware) ve authMiddleware rotadan ÖNCE kayıtlı", async () => {
    const res: any = { code: 0, status(c: number) { this.code = c; return this; }, json() { return this; } };
    const next = vi.fn();
    await (authMod as any).realAuth({ headers: {}, query: {}, cookies: {} }, res, next);
    expect(res.code).toBe(401);
    expect(next).not.toHaveBeenCalled();
    const stack = (companyRouter as any).stack;
    const authIdx = stack.findIndex((l: any) => !l.route && l.handle === (authMod as any).authMiddleware);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(stack.indexOf(layer));
  });
});

describe("yanıt şekli ve değerler", () => {
  it("boş veri", async () => {
    const { res } = await invoke();
    expect(res.body.models).toEqual([]);
    expect(res.body.autoSelection).toEqual({ enabled: null });
    expect(Object.keys(res.body).sort()).toEqual(["autoSelection", "costWindow", "generatedAt", "models"]);
  });

  it("maliyet Decimal METİN; koşu sayısı ajan başına tekil koşuların toplamı", async () => {
    db.agents = [ag("a1", "claude-sonnet-5-5"), ag("a2", "claude-sonnet-5-5")];
    db.steps = [step("a1", "r1", "0.1"), step("a1", "r1", "0.25"), step("a2", "r1", "0.000002"), step("a1", "r2", "1.0")];
    const { res } = await invoke();
    const m = res.body.models[0];
    expect(m.costThisMonthUsd).toBe("1.350002");
    expect(typeof m.costThisMonthUsd).toBe("string");
    expect(m.runCountThisMonth).toBe(3);
  });

  it("maliyet kaydı yok -> null; adım yoksa koşu 0; agentId'siz adım hiçbir satıra yazılmaz", async () => {
    db.agents = [ag("a1", "gpt-4o"), ag("a2", "gemini-1.5-pro")];
    db.steps = [step("a1", "r1", null), step(null, "r9", "50")];
    const { res } = await invoke();
    const gpt = res.body.models.find((m: any) => m.id === "gpt-4o");
    const gem = res.body.models.find((m: any) => m.id === "gemini-1.5-pro");
    expect(gpt).toMatchObject({ costThisMonthUsd: null, runCountThisMonth: 1 });
    expect(gem).toMatchObject({ costThisMonthUsd: null, runCountThisMonth: 0 });
    expect(JSON.stringify(res.body)).not.toContain("50.0");
  });

  it("null alanlar: eşleşen sağlayıcı satırı yok -> source null, access.mode null", async () => {
    db.agents = [ag("a1", "claude-sonnet-5-5")];
    const { res } = await invoke();
    expect(res.body.models[0]).toMatchObject({ provider: "ANTHROPIC", source: null, access: { scope: "agent", mode: null } });
    expect(res.body.models[0].displayName).toBeUndefined();
  });

  it("BYOK anahtarlı satır -> byok; anahtar yanıta girmez", async () => {
    db.agents = [ag("a1", "claude-sonnet-5-5")];
    db.configs = [{ tenantId: "t-1", provider: "ANTHROPIC", model: "x", isDefault: true, encryptedApiKey: "enc:SUPERSECRETKEY" }];
    const { res } = await invoke();
    expect(res.body.models[0]).toMatchObject({ provider: "ANTHROPIC", source: "byok" });
    expect(JSON.stringify(res.body)).not.toContain("SUPERSECRETKEY");
  });

  it("yerel: tek yerel aday -> local; katalog dışı kimlikte birden çok yerel aday -> provider/source null; anahtarsız bulut -> source null", async () => {
    db.agents = [ag("a1", "my-custom-model:7b"), ag("a2", "gpt-4o")];
    db.configs = [
      { tenantId: "t-1", provider: "OLLAMA", model: "x", isDefault: true, encryptedApiKey: null },
      { tenantId: "t-1", provider: "OPENAI", model: "gpt-4o", isDefault: false, encryptedApiKey: null },
    ];
    let r = (await invoke()).res.body.models;
    expect(r.find((m: any) => m.id === "my-custom-model:7b")).toMatchObject({ provider: "OLLAMA", source: "local" });
    expect(r.find((m: any) => m.id === "gpt-4o")).toMatchObject({ provider: "OPENAI", source: null });
    db.configs.push({ tenantId: "t-1", provider: "LMSTUDIO", model: "y", isDefault: false, encryptedApiKey: null });
    r = (await invoke()).res.body.models;
    expect(r.find((m: any) => m.id === "my-custom-model:7b")).toMatchObject({ provider: null, source: null });
    expect(r.find((m: any) => m.id === "gpt-4o")).toMatchObject({ provider: "OPENAI", source: null });
  });

  it("sızıntı taraması: JSON'un TÜM değerlerinde sır/URL/iç yol yok; anahtar adları yok", async () => {
    db.agents = [ag("a1", "claude-sonnet-5-5"), ag("a2", "gemma3:4b")];
    db.configs = [
      { tenantId: "t-1", provider: "ANTHROPIC", model: "m", isDefault: true, encryptedApiKey: "sk-ant-AAAA1234567890", baseUrl: "https://internal.local/v1" },
      { tenantId: "t-1", provider: "OLLAMA", model: "m", isDefault: false, encryptedApiKey: null, baseUrl: "http://192.168.1.4:11434" },
    ];
    db.steps = [step("a1", "r1", "2")];
    const { res } = await invoke();
    const values: string[] = [];
    (function walk(v: unknown) {
      if (v && typeof v === "object") Object.values(v).forEach(walk);
      else if (typeof v === "string") values.push(v);
    })(res.body);
    for (const v of values) {
      expect(v).not.toMatch(/sk-|eyJ|ghp_|xox|AKIA|secret|token|password|apikey|api_key|bearer|enc:|https?:\/\/|\/Users\/|\/home\/|\.local|192\.168|10\.0\./i);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedApiKey|baseUrl|systemPrompt|credential/i);
  });

  it("anahtar benzeri model kimlikleri atılır; atılan ajanın maliyeti hiçbir satıra yazılmaz", async () => {
    const bad = ["gsk_abc123DEF", "csk-abc123", "xai-abc123", "pplx-abc123", "sk-live-short", "AIzaSyA1234567890abcdefghij", "has space", "a".repeat(120), "Ab1" + "x9".repeat(20)];
    db.agents = bad.map((m, i) => ag(`b${i}`, m));
    db.steps = bad.map((_m, i) => step(`b${i}`, `r${i}`, "5"));
    const { res } = await invoke();
    expect(res.body.models).toEqual([]);
  });

  it("normal model kimlikleri atılmaz", () => {
    for (const id of ["claude-sonnet-5-5", "gpt-4o", "gpt-4o-mini", "llama3.1:8b", "mistral-nemo", "gemini-1.5-flash-8b", "openai/gpt-4o", "skywork-o1", "xai", "qwen2.5-72b-instruct", "moonshot-v1-128k"]) {
      expect(isSecretLike(id), id).toBe(false);
    }
    for (const id of ["gsk_abc123DEF", "csk-abc", "AIzaSyA1234567890abcdefghij", "xai-abc", "pplx-abc"]) {
      expect(isSecretLike(id), id).toBe(true);
    }
  });
});

describe("ay penceresi ve sayı yardımcıları", () => {
  it("from = UTC ay başı, to = şimdi; ham sorgu parametreleri bunlar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:30:00.000Z"));
    const { res } = await invoke();
    expect(res.body.costWindow).toEqual({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-12T10:30:00.000Z" });
    expect(res.body.generatedAt).toBe("2026-11-12T10:30:00.000Z");
    const [, , from, to] = db.calls.raw[0].values;
    expect(from.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-12T10:30:00.000Z");
  });

  it("pencere sınırı: ay başındaki adım dahil, bir önceki ayın son ms'si hariç", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:30:00.000Z"));
    db.agents = [ag("a1", "gpt-4o")];
    db.steps = [
      step("a1", "r0", "9", new Date("2026-10-31T23:59:59.999Z")),
      step("a1", "r1", "1", new Date("2026-11-01T00:00:00.000Z")),
    ];
    const { res } = await invoke();
    expect(res.body.models[0]).toMatchObject({ costThisMonthUsd: "1.000000", runCountThisMonth: 1 });
  });

  it("monthStartUtc UTC sınırları", () => {
    expect(monthStartUtc(new Date("2026-12-31T23:59:59.999Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(monthStartUtc(new Date("2027-01-01T00:00:00.000Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("toMicro/microToText: kayan nokta hatası yok, yuvarlar, üstel girdi güvenli", () => {
    expect(microToText(toMicro("0.1") + toMicro("0.2"))).toBe("0.300000");
    expect(microToText(toMicro(dec("12.5")))).toBe("12.500000");
    expect(microToText(toMicro("0.0000006"))).toBe("0.000001");
    expect(microToText(toMicro(1e-7))).toBe("0.000000");
    expect(microToText(toMicro("1e-7"))).toBe("0.000000");
    expect(microToText(toMicro(2.5e-3))).toBe("0.002500");
    expect(microToText(toMicro(Number.NaN))).toBe("0.000000");
    expect(microToText(0n)).toBe("0.000000");
  });

  it("geriye uyumluluk: mevcut rotalar duruyor", () => {
    const paths = (companyRouter as any).stack.filter((l: any) => l.route?.methods.get).map((l: any) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/:id", "/:id/agents", "/:id/models"]));
  });
});
