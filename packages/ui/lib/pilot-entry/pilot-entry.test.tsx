/** BRA-P1-07-N3 — pilot giriş kartı: bayrak, dışa aktarma akışı, hata sınıfları, kilit, önizleme, maskeleme, aria, 15 dil anahtarları. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("next-intl", () => ({ useTranslations: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}${JSON.stringify(v)}` : k) }));
vi.mock("../useAuthGuard", () => ({ useAuthGuard: () => ({ token: "synthetic-token", hydrated: true }) }));
vi.mock("../store", () => ({
  captureAuthSession: () => ({ revision: 1, tenantId: "t", token: "x" }), isAuthSessionCurrent: () => true,
  useAppStore: Object.assign((sel: any) => sel({ sessionRevision: 1 }), { getState: () => ({}) }),
}));

import PilotEntryCard from "../../components/companies/PilotEntryCard";
import { uxPilotEnabled } from "./flag";
import { toPilotPreview } from "./preview";
import { classifyPilotError, runPilotExport, pilotFileName, triggerPilotExport, shouldFocusResult, downloadJsonFile, type PilotExportState } from "./export";
import { MASK } from "../ux-kaput/mask";

const pkg = (over: Record<string, unknown> = {}) => ({
  manifest: {
    schemaVersion: "1", name: "Haftalık müşteri e-postası taslağı", version: "1.0.0", description: null,
    agents: [{ handle: "a" }, { handle: "b" }], pipelines: [{ name: "p" }],
    connectorRequests: [{ provider: "gmail", scopes: ["drafts.create"] }], syntheticDataRef: null, ...over,
  },
  syntheticData: [{ id: 1 }, { id: 2 }, { id: 3 }],
});
const html = (props: Partial<React.ComponentProps<typeof PilotEntryCard>> = {}) =>
  renderToStaticMarkup(<PilotEntryCard companyId="c1" enabled {...props} />);

function deps(fetchPackage: () => Promise<unknown>) {
  const states: PilotExportState[] = [];
  const download = vi.fn();
  const lock = { current: false };
  return { states, download, lock, d: { fileName: "f.json", fetchPackage, download, setState: (s: PilotExportState) => states.push(s), lock } };
}

describe("bayrak ve görünürlük", () => {
  it("varsayılan KAPALI; yalnız 1/true açar", () => {
    expect(uxPilotEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on"]) expect(uxPilotEnabled({ NEXT_PUBLIC_UX_PILOT: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxPilotEnabled({ NEXT_PUBLIC_UX_PILOT: v })).toBe(true);
  });
  it("kapalıyken hiçbir şey çizilmez", () => { expect(html({ enabled: false })).toBe(""); });
  it("ortam bayrağı verilmeyince de kapalı (ortamdan bağımsız: stubEnv)", () => {
    vi.stubEnv("NEXT_PUBLIC_UX_PILOT", "");
    try { expect(renderToStaticMarkup(<PilotEntryCard companyId="c1" />)).toBe(""); } finally { vi.unstubAllEnvs(); }
  });
  it("açıkken kart, senaryo ve notlar görünür", () => {
    const h = html();
    expect(h).toContain('data-testid="pilot-entry-card"');
    for (const k of ["description", "syntheticOnly", "connectorsNote"]) expect(h).toContain(`app.pilotEntry.${k}`);
  });
});

describe("dışa aktarma", () => {
  it("başarı: yükleniyor → indirme çağrısı → done; dosya adı kimlik içermez", async () => {
    const f = deps(async () => pkg());
    expect(await runPilotExport(f.d)).toBe(true);
    expect(f.states.map((s) => s.status)).toEqual(["loading", "done"]);
    expect(f.download).toHaveBeenCalledTimes(1);
    const [name, json] = f.download.mock.calls[0] as unknown as [string, string];
    expect(name).toBe("f.json");
    expect(name).not.toMatch(/c1|tenant/);
    expect(JSON.parse(json)).toEqual(pkg());
    expect(f.lock.current).toBe(false);
  });
  it("çift tıklama: uçuştayken ikinci çağrı yok sayılır, tek istek", async () => {
    let release!: (v: unknown) => void;
    const fetchPackage = vi.fn(() => new Promise<unknown>((r) => { release = r; }));
    const f = deps(fetchPackage);
    const first = runPilotExport(f.d);
    expect(await runPilotExport(f.d)).toBe(false);
    expect(fetchPackage).toHaveBeenCalledTimes(1);
    release(pkg()); await first;
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.lock.current).toBe(false); // kilit açıldı
    const again = runPilotExport(f.d); release(pkg());
    expect(await again).toBe(true);
    expect(fetchPackage).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ status: 401 }, "auth"], [{ status: 403 }, "forbidden"], [{ status: 404 }, "notFound"], [{ status: 500 }, "generic"],
    [new TypeError("Failed to fetch"), "network"], [new Error("Session expired — please sign in again."), "auth"], [new Error("boom"), "generic"],
  ])("hata %j → %s; çökmez, indirme yok, kilit açılır", async (err, kind) => {
    expect(classifyPilotError(err)).toBe(kind);
    const f = deps(async () => { throw err; });
    await runPilotExport(f.d);
    expect(f.states.at(-1)).toEqual({ status: "error", kind });
    expect(f.download).not.toHaveBeenCalled();
    expect(f.lock.current).toBe(false);
  });
  it("bozuk paket gövdesi: genel hata, indirme yok", async () => {
    const f = deps(async () => ({ nope: 1 }));
    await runPilotExport(f.d);
    expect(f.states.at(-1)).toEqual({ status: "error", kind: "generic" });
    expect(f.download).not.toHaveBeenCalled();
  });
  it("iptal edilince (sökülme) durum yazılmaz", async () => {
    const f = deps(async () => pkg());
    await runPilotExport({ ...f.d, isCancelled: () => true });
    expect(f.states).toEqual([]);
  });
  it("downloadJsonFile: blob + anchor tıklaması", () => {
    const click = vi.fn(); const a: any = { click, remove: vi.fn() };
    const create = vi.fn((_b: Blob) => "blob:x"); const revoke = vi.fn();
    vi.stubGlobal("document", { createElement: () => a, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    downloadJsonFile("f.json", "{}");
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(a.download).toBe("f.json"); expect(click).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("önizleme", () => {
  it("özet: ad, sayılar, bağlantı etiketi", () => {
    expect(toPilotPreview(pkg())).toEqual({ name: "Haftalık müşteri e-postası taslağı", agents: 2, pipelines: 1, connectors: ["gmail"], connectorsHidden: 0, records: 3 });
  });
  it.each([null, undefined, 5, "x", [], {}, { manifest: {}, syntheticData: [] }, { manifest: { name: "a", agents: [], pipelines: [] }, syntheticData: "x" }])("bozuk %j → null", (raw) => {
    expect(toPilotPreview(raw)).toBeNull();
  });
  it("adlar maskelenir; token benzeri ad/etiket sızmaz", () => {
    const p = toPilotPreview(pkg({ name: "Ad sk-abcdefghijklmnop12345", connectorRequests: [{ provider: "ghp_abcdefghijklmnopqrstuv" }] }))!;
    expect(p.name).toContain(MASK); expect(p.name).not.toContain("sk-abcdefgh");
    expect(p.connectors[0]).toContain(MASK);
  });
  it("çok bağlantı: kırpılır, tekrarlar atılır", () => {
    const reqs = Array.from({ length: 14 }, (_, i) => ({ provider: `p${i}`, scopes: [] })).concat([{ provider: "p0", scopes: [] }]);
    const p = toPilotPreview(pkg({ connectorRequests: reqs }))!;
    expect(p.connectors).toHaveLength(10); expect(p.connectorsHidden).toBe(4);
  });
  it("veri yokken 'veri yok'; hazırken ham JSON dökülmez", () => {
    expect(html()).toContain("pilot-entry-nodata");
    const preview = toPilotPreview(pkg())!;
    const h = html({ initialState: { status: "done", preview } });
    expect(h).not.toContain("pilot-entry-nodata");
    expect(h).toContain("pilot-preview-agents"); expect(h).toContain("gmail");
    expect(h).not.toContain("schemaVersion"); expect(h).not.toContain("drafts.create");
  });
});

describe("erişilebilirlik", () => {
  it("bölge etiketli, durum aria-live, buton metinli", () => {
    const h = html();
    expect(h).toContain('aria-labelledby="pilot-entry-h"');
    expect(h).toContain('aria-live="polite"'); expect(h).toContain('role="status"');
    expect(h).toMatch(/<button type="button"[^>]*>app\.pilotEntry\.export<\/button>/);
  });
  it("yüklenirken buton kilitli (aria-disabled), aria-busy", () => {
    const h = html({ initialState: { status: "loading" } });
    expect(h).toContain('aria-busy="true"'); expect(h).toContain('aria-disabled="true"');
    expect(h).toContain("app.pilotEntry.exporting");
  });
  it("hata: role=alert, odaklanabilir, tür işaretli", () => {
    const h = html({ initialState: { status: "error", kind: "forbidden" } });
    expect(h).toContain('role="alert"'); expect(h).toContain('tabindex="-1"'); expect(h).toContain("app.pilotEntry.error.forbidden");
  });
  it("RTL: yön-bağımsız mantıksal stil, adlar bdi içinde", () => {
    const h = html({ initialState: { status: "done", preview: toPilotPreview(pkg())! } });
    expect(h).toContain("<bdi>"); expect(h).not.toMatch(/margin-?left|padding-?left|text-align:\s*left/i);
  });
});

describe("dosya adı, oturum hatası, tetikleyici, odak, revoke", () => {
  it("dosya adı: ilk 8 güvenli karakter, yol/kontrol karakteri atılır, boşsa yedek", () => {
    expect(pilotFileName("ABCDEF12-3456-7890")).toBe("braavolabs-micro-app-abcdef12.json");
    expect(pilotFileName("../../etc/passwd")).toBe("braavolabs-micro-app-etcpassw.json");
    expect(pilotFileName("a\u0000b\n/c.d")).toBe("braavolabs-micro-app-abcd.json");
    expect(pilotFileName("---")).toBe("braavolabs-micro-app-company.json");
    expect(pilotFileName("")).toMatch(/^braavolabs-micro-app-company\.json$/);
    expect(pilotFileName("c1")).not.toBe(pilotFileName("c2"));
    expect(pilotFileName("x".repeat(40))).toMatch(/^braavolabs-micro-app-[a-z0-9-]{1,8}\.json$/);
  });
  it("SessionChangedError → auth", async () => {
    const { SessionChangedError } = await import("../api");
    expect(classifyPilotError(new SessionChangedError())).toBe("auth");
  });
  it("tıklama → istek: hazırken bir kez başlar, dosya adı şirketten gelir", async () => {
    const f = deps(async () => pkg());
    const fetchPackage = vi.fn(f.d.fetchPackage);
    const ctx = { hydrated: true, token: "t", companyId: "company-12345", busy: false, ...f.d, fetchPackage };
    expect(triggerPilotExport(ctx)).toBe(true);
    await vi.waitFor(() => expect(f.download).toHaveBeenCalledTimes(1));
    expect(f.download.mock.calls[0][0]).toBe("braavolabs-micro-app-company-.json");
    expect(fetchPackage).toHaveBeenCalledTimes(1);
  });
  it("aria-disabled düğmede (meşgul/kilitli/oturumsuz) tıklama ikinci istek başlatmaz", () => {
    const fetchPackage = vi.fn(async () => pkg());
    const f = deps(fetchPackage);
    const base = { hydrated: true, token: "t", companyId: "c1", busy: false, ...f.d };
    expect(triggerPilotExport({ ...base, busy: true })).toBe(false);
    expect(triggerPilotExport({ ...base, hydrated: false })).toBe(false);
    expect(triggerPilotExport({ ...base, token: null })).toBe(false);
    expect(triggerPilotExport({ ...base, companyId: "" })).toBe(false);
    f.lock.current = true;
    expect(triggerPilotExport(base)).toBe(false);
    expect(fetchPackage).not.toHaveBeenCalled();
  });
  it("art arda iki tetik: tek istek", () => {
    const fetchPackage = vi.fn(() => new Promise<unknown>(() => {}));
    const f = deps(fetchPackage);
    const base = { hydrated: true, token: "t", companyId: "c1", busy: false, ...f.d };
    expect(triggerPilotExport(base)).toBe(true);
    expect(triggerPilotExport(base)).toBe(false);
    expect(fetchPackage).toHaveBeenCalledTimes(1);
  });
  it("odak yalnız sonuç/hata durumunda; bileşen effect'i bu kararı kullanır", () => {
    expect(shouldFocusResult("done")).toBe(true); expect(shouldFocusResult("error")).toBe(true);
    expect(shouldFocusResult("idle")).toBe(false); expect(shouldFocusResult("loading")).toBe(false);
    const src = readFileSync(resolve(process.cwd(), "components/companies/PilotEntryCard.tsx"), "utf8");
    expect(src).toMatch(/if \(shouldFocusResult\(state\.status\)\) resultRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/onClick=\{onExport\}/); expect(src).toContain("triggerPilotExport(");
  });
  it("downloadJsonFile: object URL zamanlayıcıdan sonra serbest bırakılır", () => {
    vi.useFakeTimers();
    const a: any = { click: vi.fn(), remove: vi.fn() };
    const revoke = vi.fn();
    vi.stubGlobal("document", { createElement: () => a, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:y", revokeObjectURL: revoke });
    downloadJsonFile("f.json", "{}");
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:y");
    vi.useRealTimers(); vi.unstubAllGlobals();
  });
  it("dürüst metin: her dilde taslak/e-posta/gönderilmez/gerçek-müşteri iddiası yok", () => {
    const dir = resolve(process.cwd(), "messages");
    // Yasak iddia kökleri (küçük harf), dilin kendi karşılıklarıyla. Eski anahtarların yokluğu ayrıca denetlenir.
    const banned: Record<string, string[]> = {
      en: ["email", "draft", "nothing is sent", "real customer"],
      tr: ["e-posta", "taslak", "gönderilmez", "gerçek müşteri"],
      de: ["e-mail", "entwurf", "nichts gesendet", "echte kunden"],
      fr: ["e-mail", "brouillon", "rien n'est envoyé", "clients réels", "client réelle"],
      es: ["correo", "borrador", "no se envía", "clientes reales"],
      "es-419": ["correo", "borrador", "no se envía", "clientes reales"],
      it: ["e-mail", "bozza", "non viene inviato", "clienti reali"],
      "pt-BR": ["e-mail", "rascunho", "nada é enviado", "clientes reais"],
      pl: ["e-mail", "szkic", "nic nie jest wysyłane", "prawdziwych danych klientów"],
      id: ["email", "draf", "tidak ada yang dikirim", "pelanggan asli"],
      ja: ["メール", "下書き", "送信されません", "実際の顧客"],
      ko: ["이메일", "초안", "발송되지 않", "실제 고객"],
      "zh-Hans": ["邮件", "草稿", "不会发送任何", "真实客户"],
      hi: ["ईमेल", "ड्राफ्ट", "भेजा नहीं जाता", "असली ग्राहक"],
      ar: ["البريد", "مسودة", "لا يُرسل", "عملاء حقيقية"],
    };
    const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(files.map((n) => n.replace(/\.json$/, "")).sort()).toEqual(Object.keys(banned).sort());
    for (const f of files) {
      const loc = f.replace(/\.json$/, "");
      const p = JSON.parse(readFileSync(resolve(dir, f), "utf8")).app.pilotEntry;
      expect(p.scenarioName, f).toBeUndefined(); expect(p.draftOnly, f).toBeUndefined(); expect(p.noSecrets, f).toBeUndefined();
      expect(typeof p.connectorsNote, f).toBe("string");
      const claims = [p.title, p.description, p.syntheticOnly, p.connectorsNote].join(" ").toLowerCase();
      for (const bad of banned[loc]) expect(claims.includes(bad.toLowerCase()), `${f}: "${bad}"`).toBe(false);
    }
    const en = JSON.parse(readFileSync(resolve(dir, "en.json"), "utf8")).app.pilotEntry;
    expect(en.connectorsNote).toMatch(/does not enforce/);
    expect(en.connectorsNote).not.toMatch(/show the actions/);
  });
});

describe("15 dil anahtar eşitliği ve sayfa bağlantısı", () => {
  const dir = resolve(process.cwd(), "messages");
  const flat = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const en = JSON.parse(readFileSync(resolve(dir, "en.json"), "utf8"));
  it("15 dilde app.pilotEntry anahtar kümesi eşit ve boş değil", () => {
    expect(files).toHaveLength(15);
    const want = flat(en.app.pilotEntry).sort();
    for (const f of files) {
      const j = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      expect(flat(j.app.pilotEntry).sort(), f).toEqual(want);
      for (const k of want) expect(String(k.split(".").reduce((a: any, s) => a[s], j.app.pilotEntry)).trim(), `${f}:${k}`).not.toBe("");
    }
  });
  it("bileşenin kullandığı tüm anahtarlar en.json'da var", () => {
    const have = new Set(flat(en.app.pilotEntry));
    const src = readFileSync(resolve(process.cwd(), "components/companies/PilotEntryCard.tsx"), "utf8");
    const used = [...src.matchAll(/pt\("([A-Za-z.]+)"/g)].map((m) => m[1]);
    for (const k of used) expect(have.has(k), k).toBe(true);
    for (const kind of ["auth", "forbidden", "notFound", "network", "generic"]) expect(have.has(`error.${kind}`)).toBe(true);
  });
  it("şirket sayfası kartı bağlar", () => {
    expect(readFileSync(resolve(process.cwd(), "app/companies/[id]/page.tsx"), "utf8")).toContain("<PilotEntryCard companyId={companyId} />");
  });
});
