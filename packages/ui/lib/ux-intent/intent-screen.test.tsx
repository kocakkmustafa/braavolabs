import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import StartPage from "../../app/start/page";
import { AgentPanel } from "../../components/start/AgentPanel";
import { IntentBar } from "../../components/start/IntentBar";
import { PlanPanel } from "../../components/start/PlanPanel";
import StartIntent from "../../components/start/StartIntent";
import StartLegacy from "../../components/start/StartLegacy";
import type { PlanCardView } from "../planCardParse";
import { UX_INTENT_ENV, uxIntentEnabled } from "./flag";

const UI = join(__dirname, "..", "..");
const messages = (code: string) => JSON.parse(readFileSync(join(UI, "messages", `${code}.json`), "utf8"));
const LOCALES = readdirSync(join(UI, "messages")).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
const tr = createTranslator({ locale: "tr", messages: messages("tr") }) as unknown as (k: string, v?: Record<string, string | number>) => string;

const CARD: PlanCardView = {
  title: "Ekibe duyuru gönder", goal: "Slack'e duyuru gönder.", risk: "high",
  steps: [{ title: "Slack'e gönder", tool: "slack.post", needsApproval: true, risk: "high" }],
  estimate: { costUsd: { low: null, high: null }, priced: false },
};

describe("bayrak (BRA-UX-05a)", () => {
  it("varsayılan KAPALI; yalnız 1/true açar", () => {
    expect(UX_INTENT_ENV).toBe("NEXT_PUBLIC_UX_INTENT");
    expect(uxIntentEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on", "2"]) expect(uxIntentEnabled({ NEXT_PUBLIC_UX_INTENT: v })).toBe(false);
    for (const v of ["1", "true", "TRUE", " 1 "]) expect(uxIntentEnabled({ NEXT_PUBLIC_UX_INTENT: v })).toBe(true);
  });
  it("UX-04 prototip bayrağı bunu açmaz (ayrı bayrak)", () => {
    expect(uxIntentEnabled({ NEXT_PUBLIC_UX_LAB: "1" })).toBe(false);
  });
  it("/start: bayrak kapalıyken ESKİ bileşen, açıkken yenisi", () => {
    const prev = process.env[UX_INTENT_ENV];
    try {
      delete process.env[UX_INTENT_ENV];
      expect(StartPage().type).toBe(StartLegacy);
      process.env[UX_INTENT_ENV] = "0";
      expect(StartPage().type).toBe(StartLegacy);
      process.env[UX_INTENT_ENV] = "1";
      expect(StartPage().type).toBe(StartIntent);
    } finally {
      if (prev === undefined) delete process.env[UX_INTENT_ENV]; else process.env[UX_INTENT_ENV] = prev;
    }
  });
  it("bayrak istek anında okunur: sayfa dinamik, sabit process.env erişimi yok", () => {
    const page = readFileSync(join(UI, "app/start/page.tsx"), "utf8");
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
    expect(readFileSync(join(UI, "lib/ux-intent/flag.ts"), "utf8")).not.toMatch(/process\.env\.NEXT_PUBLIC_UX_INTENT/);
  });
});

describe("next-intl: her kullanılan anahtar her dilde var", () => {
  const sources = readdirSync(join(UI, "components/start")).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(join(UI, "components/start", f), "utf8"));
  const literal = [...new Set(sources.flatMap((s) => [...s.matchAll(/\bt\("((?:app|surface)\.[A-Za-z.]+)"/g)].map((m) => m[1])))];
  const templated = [...new Set(sources.flatMap((s) => [...s.matchAll(/\bt\(`((?:app|surface)\.[A-Za-z.]+)\$\{/g)].map((m) => m[1])))];
  const get = (m: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  it("anahtar listesi boş değil ve app.intent'i kapsar", () => {
    expect(literal.length).toBeGreaterThan(20);
    expect(literal.some((k) => k.startsWith("app.intent."))).toBe(true);
  });
  it.each(LOCALES)("%s", (code) => {
    const m = messages(code);
    for (const k of literal) expect(typeof get(m, k), `${code}:${k}`).toBe("string");
    for (const prefix of templated) {
      const node = get(m, prefix.replace(/\.$/, ""));
      expect(node && typeof node === "object", `${code}:${prefix}`).toBe(true);
    }
    for (const kind of ["chat", "job", "agent"]) {
      expect(typeof get(m, `app.intent.kind.${kind}`)).toBe("string");
      expect(typeof get(m, `app.intent.submit.${kind}`)).toBe("string");
    }
    for (const kind of ["low", "medium", "high"]) expect(typeof get(m, `app.plan.risk.${kind}`)).toBe("string");
  });
});

describe("IntentBar", () => {
  const html = renderToStaticMarkup(<IntentBar t={tr} busy={false} onSubmit={() => {}} />);
  it("etiket, radiogroup (3 seçenek), roving tabindex ve boşken devre dışı gönder", () => {
    expect(html).toContain("Ne yapmak istiyorsun?");
    expect(html).toContain('role="radiogroup"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(3);
    // Varsayılan seçili SOHBET (boş metin düşük güven): yalnız o tabIndex=0
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*>Sohbet</);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Sohbet başlat</);
  });
  it("yerel sınıflayıcının ipucu olduğunu söyler (uydurma güven yok)", () => {
    expect(html).toContain("yerel bir ipucudur");
  });
});

describe("PlanPanel", () => {
  const base = { card: CARD, t: tr, locale: "tr-TR", busy: false, onStart: () => {}, onCancel: () => {}, onReplan: () => {} };
  it("onaylı adım uyarısı, fiyat bilinmiyor ve model satırının YOK olduğu açıkça yazılır", () => {
    const html = renderToStaticMarkup(<PlanPanel {...base} />);
    expect(html).toContain("Slack&#x27;e gönder");
    expect(html).toContain("onay gerekli, yüksek risk");
    expect(html).toContain("araç: slack.post");
    expect(html).toContain("fiyat bilinmiyor");
    expect(html).toContain("Adım başına model satırı: henüz yok");
    expect(html).toContain('data-risk="high"');
  });
  it("approvalGate hatası görünür; Çalıştır devre dışı (düğme gizlenmez)", () => {
    const html = renderToStaticMarkup(<PlanPanel {...base} startError="approvalGate" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("onay kapısı şu an kapalı");
    expect(html).toMatch(/<button type="button"[^>]* disabled=""[^>]*>Çalıştır ▸</);
  });
  it("fiyatlı kartta maliyet aralığı gösterilir", () => {
    const html = renderToStaticMarkup(<PlanPanel {...base} card={{ ...CARD, estimate: { costUsd: { low: 0.02, high: 0.06 }, priced: true } }} />);
    expect(html).toMatch(/\$0[.,]02/);
    expect(html).not.toContain("fiyat bilinmiyor");
  });
});

describe("AgentPanel — compose ajanı HEMEN kaydeder", () => {
  const noop = () => {};
  it("onay kartı tek adımı açıkça söyler ve açık bir oluştur düğmesi sunar", () => {
    const html = renderToStaticMarkup(<AgentPanel state={{ phase: "confirm", description: "Satış için bir ajan oluştur" }} t={tr} onCreate={noop} onCancel={noop} />);
    expect(html).toContain("Satış için bir ajan oluştur");
    expect(html).toContain("ajanı hemen kaydeder");
    expect(html).toContain("Ajanı hemen oluştur");
    expect(html).toContain('data-testid="intent-agent-confirm"');
  });
  it("şirket seçilmemişse uyarı gösterir", () => {
    const html = renderToStaticMarkup(<AgentPanel state={{ phase: "confirm", description: "x y z", error: "workspaceRequired" }} t={tr} onCreate={noop} onCancel={noop} />);
    expect(html).toContain('role="alert"');
  });
  it("çıkarılan araçlar görünür uyarıdır; kayıt gerçeği yazılır", () => {
    const html = renderToStaticMarkup(<AgentPanel state={{ phase: "done", description: "d", result: { name: "Satış ajanı", role: "sales", tools: ["read"], droppedTools: ["slack.post", "crm"] } }} t={tr} onCreate={noop} onCancel={noop} />);
    expect(html).toContain("Çıkarılan araç (2): slack.post, crm");
    expect(html).toContain("Ajan kaydedildi.");
  });
  it("hata türüne göre yerelleştirilmiş mesaj ve yeniden dene", () => {
    const html = renderToStaticMarkup(<AgentPanel state={{ phase: "error", description: "d", kind: "network" }} t={tr} onCreate={noop} onCancel={noop} />);
    expect(html).toContain("Sunucuya ulaşılamadı");
    expect(html).toContain("Yeniden dene");
  });
  it("kayıt yalnız onay kartındaki düğmeden: çubuk bileşeni compose'a erişemez", () => {
    expect(readFileSync(join(UI, "components/start/IntentBar.tsx"), "utf8")).not.toMatch(/composeAgent|jobStart|jobPlan/);
    const screen = readFileSync(join(UI, "components/start/StartIntent.tsx"), "utf8");
    expect(screen.match(/api\.composeAgent\(/g)?.length).toBe(1);
    expect(screen).toMatch(/const createAgent = async/);
  });
});
