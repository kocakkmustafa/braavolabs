import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import KaputPanel, { clip, statusKey, durationParts, RUN_ERROR_MAX, REASONING_MAX } from "../../components/job/KaputPanel";
import type { T } from "../../components/inbox/InboxParts";
import { parseKaput, type Kaput } from "../ux-lab/facts";

const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);
const noop = () => {};
const render = (kaput: Kaput, full: boolean) => renderToStaticMarkup(<KaputPanel load={{ status: "ready", kaput }} full={full} t={t} locale="tr" onRetry={noop} />).replace(/&quot;/g, '"');
const RAW = {
  costUsd: 0.42, budgetUsd: 5, error: "Connection reset by peer",
  steps: [
    { id: "s2", stepIndex: 1, name: "Taslağı yaz", agentRole: "writer", status: "FAILED", costUsd: 0.32, durationMs: 1234, reasoning: "Önce özet çıkar", input: { secret: "RAW-INPUT" }, output: "RAW-OUTPUT",
      toolCalls: [{ id: "t2", toolName: "gmail.send", status: "FAILED", durationMs: 80, error: "403 Forbidden", input: { to: "x" }, output: { body: "RAW-BODY" } }] },
    { id: "s1", stepIndex: 0, name: "Topla", agentRole: "researcher", status: "COMPLETED", costUsd: 0.1, durationMs: 500, toolCalls: [] },
  ],
};
const kaput = (over: Record<string, unknown> = {}) => ({ ...parseKaput({ ...RAW, ...over }), handoffCount: 1 });

describe("KaputPanel", () => {
  it("Sade: kök testid, özet metni, sıralı kompakt satırlar, metinli durum rozeti", () => {
    const h = render(kaput(), false);
    expect(h).toContain('data-testid="job-kaput"');
    expect(h).toContain('app.jobs.kaput.summary{"steps":2,"tools":1');
    expect(h.indexOf("Topla")).toBeLessThan(h.indexOf("Taslağı yaz"));
    expect(h).toContain("app.jobs.kaput.stepStatus.completed");
    expect(h).toContain("app.jobs.kaput.stepStatus.failed");
    expect(h).not.toContain('data-testid="job-kaput-step"');
  });
  it("Sade: başarısız adımın araç hatası görünür; Tam: ajan rolü, süre, araç adı", () => {
    expect(render(kaput(), false)).toContain("403 Forbidden");
    const h = render(kaput(), true);
    expect(h.match(/data-testid="job-kaput-step"/g)).toHaveLength(2);
    for (const x of ["writer", "gmail.send", "403 Forbidden", "app.jobs.kaput.agent", "Önce özet çıkar"]) expect(h).toContain(x);
    expect(h).toContain('"value":"1,2"');
    expect(h).toContain('"value":"80"');
    expect(h).toContain("aria-labelledby");
    expect(h).not.toContain("<details");
  });
  it("koşu hatası: Sade'de insan cümlesi, ham metin yok; Tam'da ham metin; role=status", () => {
    const s = render(kaput(), false);
    expect(s).toContain("app.jobs.kaput.runErrorTitle");
    expect(s).toContain('role="status" data-testid="job-kaput-error"');
    expect(s).not.toContain("Connection reset");
    expect(render(kaput(), true)).toContain("Connection reset by peer");
  });
  it("koşu hatası yoksa uyarı bloğu yok; 500 karakterde kırpılır", () => {
    expect(render(kaput({ error: null }), true)).not.toContain("job-kaput-error");
    const long = "hata ".repeat(300);
    const h = render(kaput({ error: long }), true);
    expect(h).toContain("hata ".repeat(99) + "hata…");
    expect(h).not.toContain("hata ".repeat(101));
    expect(clip("a".repeat(REASONING_MAX + 5), REASONING_MAX)).toHaveLength(REASONING_MAX + 1);
  });
  it("bütçe varken kullanım oranı; yokken satır yok", () => {
    const h = render(kaput(), false);
    expect(h).toContain('data-testid="job-kaput-budget"');
    expect(h).toContain('"percent":"%8"');
    expect(render(kaput({ budgetUsd: null }), false)).not.toContain("job-kaput-budget");
    expect(render(kaput({ budgetUsd: 0 }), false)).not.toContain("job-kaput-budget");
  });
  it("Tam: adım maliyeti ve toplam içindeki pay", () => {
    const h = render(kaput(), true);
    expect(h).toContain("app.jobs.kaput.share");
    expect(h).toContain('"percent":"%76"');
  });
  it("bilinmeyen durum: Sade unknown etiketi, Tam'da ham değer parantezle", () => {
    const k = kaput({ steps: [{ id: "a", stepIndex: 0, name: "A", status: "weird_state" }] });
    const s = render(k, false);
    expect(s).toContain("app.jobs.kaput.stepStatus.unknown");
    expect(s).not.toContain("weird_state");
    expect(render(k, true)).toContain("app.jobs.kaput.stepStatus.unknown (weird_state)");
    expect(statusKey("CANCELED")).toBe("cancelled");
    expect(statusKey("zzz")).toBeNull();
  });
  it("boş adım: 'kayıt yok' metni ve 'sonra gelecek' notu kalır", () => {
    const h = render(kaput({ steps: [] }), true);
    expect(h).toContain("app.jobs.kaput.noSteps");
    expect(h).toContain("app.jobs.kaput.later");
  });
  it("XSS benzeri metin kaçışlı basılır", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const h = render(kaput({ error: evil, steps: [{ id: "a", stepIndex: 0, name: evil, status: "failed", reasoning: evil, error: evil, toolCalls: [{ toolName: evil, status: "failed", error: evil }] }] }), true);
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
  it("ham input/output/payload alanları çıktıda YOK", () => {
    for (const full of [false, true]) {
      const h = render(kaput(), full);
      for (const x of ["RAW-INPUT", "RAW-OUTPUT", "RAW-BODY", "secret"]) expect(h).not.toContain(x);
    }
  });
  it("yükleniyor / hata durumları mevcut davranışta", () => {
    const l = renderToStaticMarkup(<KaputPanel load={{ status: "loading" }} full={false} t={t} locale="tr" onRetry={noop} />);
    expect(l).toContain('role="status" aria-busy="true"');
    const e = renderToStaticMarkup(<KaputPanel load={{ status: "error" }} full={false} t={t} locale="tr" onRetry={noop} />);
    expect(e).toContain('role="alert"');
    expect(e).toMatch(/app\.jobs\.kaput\.error( |<)/);
    expect(e).not.toContain("errorLabel");
    expect(e).toContain("app.inbox.retryLoad");
  });
  it("araç çağrısı olmayan adım Tam'da 'araç çağrısı yok' der", () => {
    expect(render(kaput(), true)).toContain("app.jobs.kaput.noTools");
  });
});

describe("parseKaput genişlemesi", () => {
  it("runError, budgetUsd, adım error okunur", () => {
    const k = parseKaput({ error: "boom", budgetUsd: "5", steps: [{ id: "a", error: "bad" }] });
    expect(k.runError).toBe("boom");
    expect(k.budgetUsd).toBe(5);
    expect(k.steps[0].error).toBe("bad");
  });
  it("bilinmeyen şekilde güvenli: boş/yanlış tipler null", () => {
    for (const raw of [null, undefined, "x", 5, [], { error: 7, budgetUsd: "abc", steps: "no" }, { budgetUsd: -1, error: "  " }]) {
      const k = parseKaput(raw);
      expect(k.runError ?? null).toBeNull();
      expect(k.budgetUsd ?? null).toBeNull();
      expect(k.steps).toEqual([]);
    }
  });
});

describe("KaputPanel — gözden geçirme düzeltmeleri", () => {
  it("Sade: tamamlandı adımda hatalı araç çağrısı ve adım hatası 'Hata:' etiketiyle görünür", () => {
    const k = kaput({ steps: [{ id: "a", stepIndex: 0, name: "A", status: "COMPLETED", error: "adim uyari", toolCalls: [{ id: "t", toolName: "x", status: "COMPLETED", error: "kisa hata" }] }] });
    const h = render(k, false);
    expect(h).toContain("app.jobs.kaput.errorLabel: adim uyari");
    expect(h).toContain("app.jobs.kaput.errorLabel: kisa hata");
  });
  it("status'u eksik ama hatalı araç çağrısı 'failed' etiketi alır", () => {
    const k = kaput({ steps: [{ id: "a", stepIndex: 0, name: "A", status: "running", toolCalls: [{ id: "t", toolName: "x", error: "boom" }] }] });
    const h = render(k, true);
    expect(h).not.toContain("stepStatus.completed");
    expect(h).toContain("app.jobs.kaput.stepStatus.failed");
  });
  it("bütçe aşımı: metinli uyarı; aşım yoksa yok; toplam null + bütçe var → satır yok", () => {
    expect(render(kaput({ costUsd: 6 }), false)).toContain("app.jobs.kaput.overBudget");
    expect(render(kaput({ costUsd: 5 }), false)).not.toContain("overBudget");
    expect(render(kaput({ costUsd: null }), false)).not.toContain("job-kaput-budget");
  });
  it("el değiştirme okunamadıysa 'bilgi yok'", () => {
    const h = render({ ...kaput(), handoffCount: null }, false);
    expect(h).toContain('"handoffs":"app.jobs.kaput.unknown"');
  });
  it("süre: negatif → bilgi yok; sınır 999,6 ms → 1,0 sn; 999,4 → 999 ms", () => {
    expect(durationParts(-5)).toBeNull();
    expect(durationParts(NaN)).toBeNull();
    expect(durationParts(999.4)).toEqual({ unit: "ms", value: 999 });
    expect(durationParts(999.6)?.unit).toBe("s");
    const h = render(kaput({ steps: [{ id: "a", stepIndex: 0, name: "A", status: "completed", durationMs: 999.6 }, { id: "b", stepIndex: 1, name: "B", status: "completed", durationMs: -3 }] }), true);
    expect(h).toContain('"value":"1,0"');
    expect(h).toContain("app.jobs.kaput.duration:</span><span dir=\"auto\" style=\"overflow-wrap:anywhere;word-break:break-word;min-width:0\">app.jobs.kaput.unknown");
  });
  it("kırpma vekil çiftini bölmez; uzun ad kırpılır; maske kırpmadan önce çalışır", () => {
    const emoji = "😀".repeat(10);
    expect(clip(emoji, 5)).toBe("😀".repeat(5) + "…");
    expect(clip(emoji, 5)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const h = render(kaput({ error: "x".repeat(490) + " Bearer abcdefghijklmnop1234" }), true);
    expect(h).not.toContain("abcdefghij");
    const long = render(kaput({ steps: [{ id: "a", stepIndex: 0, name: "n".repeat(300), status: "completed" }] }), false);
    expect(long).not.toContain("n".repeat(121));
  });
  it("hata/gerekçe metinlerinde sırlar maskelenir; araç adı ltr, serbest metin dir=auto", () => {
    const h = render(kaput({ steps: [{ id: "a", stepIndex: 0, name: "A", status: "failed", reasoning: "token ghp_" + "a".repeat(30), toolCalls: [{ id: "t", toolName: "tool", status: "failed", error: "GET https://api.x.com/v1?key=SECRET123" }] }] }), true);
    expect(h).not.toContain("ghp_a");
    expect(h).not.toContain("SECRET123");
    expect(h).toContain("[gizlendi]");
    expect(h).toContain('dir="ltr"');
    expect(h).toContain('dir="auto"');
  });
});
