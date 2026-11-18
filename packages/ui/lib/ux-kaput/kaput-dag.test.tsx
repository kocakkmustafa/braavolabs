import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import KaputPanel from "../../components/job/KaputPanel";
import { clipWide } from "../../components/job/KaputDag";
import type { T } from "../../components/inbox/InboxParts";
import { buildKaputGraph, parseKaput, GRAPH_MAX_NODES, type Kaput } from "../ux-kaput/facts";

const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);
const render = (k: Kaput, locale = "en") => renderToStaticMarkup(<KaputPanel load={{ status: "ready", kaput: k }} full={false} t={t} locale={locale} onRetry={() => {}} />).replace(/&quot;/g, '"');
const step = (i: number, extra: Record<string, unknown> = {}) => ({ id: `s${i}`, stepIndex: i, name: `Adım ${i}`, status: "COMPLETED", ...extra });
const seq = (steps: unknown[], defs: unknown[] | null, type = "SEQUENTIAL") => parseKaput({ steps, pipeline: { pipelineType: type, ...(defs ? { steps: defs } : {}) } });
const def = (i: number, order = i) => ({ name: `Adım ${i}`, agentRole: "x", order });

describe("buildKaputGraph", () => {
  it("SEQUENTIAL zincir: her adım bir öncekine bağlı, seviye = sıra", () => {
    const g = buildKaputGraph(seq([step(0), step(1), step(2)], [def(0), def(1), def(2)]));
    expect(g.source).toBe("order");
    expect(g.edges).toEqual([{ from: "s0", to: "s1" }, { from: "s1", to: "s2" }]);
    expect(g.levels).toEqual([["s0"], ["s1"], ["s2"]]);
    expect(g.consistent).toBe(true);
  });
  it("aynı order = paralel dal; sonraki grup hepsine bağlı", () => {
    const g = buildKaputGraph(seq([step(0), step(1), step(2), step(3)], [def(0, 0), def(1, 1), def(2, 1), def(3, 2)]));
    expect(g.levels).toEqual([["s0"], ["s1", "s2"], ["s3"]]);
    expect(g.edges).toHaveLength(4);
    expect(g.edges).toContainEqual({ from: "s1", to: "s3" });
    expect(g.edges).toContainEqual({ from: "s2", to: "s3" });
  });
  it("order eksikse dizi sırası kullanılır (runner ile aynı)", () => {
    const g = buildKaputGraph(seq([step(0), step(1)], [{ name: "Adım 0" }, { name: "Adım 1" }]));
    expect(g.levels).toEqual([["s0"], ["s1"]]);
  });
  it("kısmi koşu (yalnız ilk adımlar kayıtlı) hâlâ çizilir", () => {
    const g = buildKaputGraph(seq([step(0), step(1)], [def(0), def(1), def(2)]));
    expect(g.source).toBe("order");
    expect(g.nodes).toHaveLength(2);
  });
  it("HIERARCHICAL, tür yok ya da tanım yok → çıkarım yok (kenar uydurulmaz)", () => {
    for (const k of [seq([step(0), step(1)], [def(0), def(1)], "HIERARCHICAL"), parseKaput({ steps: [step(0)] }), seq([step(0)], null)]) {
      const g = buildKaputGraph(k);
      expect(g.source).toBe("none");
      expect(g.edges).toEqual([]);
      expect(g.nodes).toEqual([]);
    }
  });
  it("ad uyuşmazlığı: çıkarım yok ve tutarsız işaretlenir", () => {
    const g = buildKaputGraph(seq([step(0), step(1, { name: "Başka" })], [def(0), def(1)]));
    expect(g.source).toBe("none");
    expect(g.consistent).toBe(false);
  });
  it("API dependsOn: eşlenir; bilinmeyen kimlik ve kendine kenar atlanır, tutarsız notu", () => {
    const g = buildKaputGraph(parseKaput({ steps: [step(0, { dependsOn: [] }), step(1, { dependsOn: ["s0", "yok", "s1"] }), step(2, { dependsOn: ["s0", "s1"] })] }));
    expect(g.source).toBe("api");
    expect(g.edges).toEqual([{ from: "s0", to: "s1" }, { from: "s0", to: "s2" }, { from: "s1", to: "s2" }]);
    expect(g.levels).toEqual([["s0"], ["s1"], ["s2"]]);
    expect(g.consistent).toBe(false);
  });
  it("döngü: çökmez, döngü kenarları atılır, tutarsız", () => {
    const g = buildKaputGraph(parseKaput({ steps: [step(0), step(1, { dependsOn: ["s0", "s2"] }), step(2, { dependsOn: ["s1"] }), step(3, { dependsOn: ["s0"] })] }));
    expect(g.consistent).toBe(false);
    expect(g.nodes).toHaveLength(4);
    expect(g.edges).not.toContainEqual({ from: "s1", to: "s2" });
    expect(g.edges).toContainEqual({ from: "s0", to: "s3" });
    expect(g.nodes.every((n) => Number.isFinite(n.level))).toBe(true);
  });
  it("boş adım listesi", () => {
    const g = buildKaputGraph(parseKaput({ steps: [] }));
    expect(g).toMatchObject({ source: "none", nodes: [], total: 0, consistent: true, truncated: false });
  });
  it("büyük graf kırpılır", () => {
    const n = GRAPH_MAX_NODES + 10;
    const g = buildKaputGraph(seq(Array.from({ length: n }, (_, i) => step(i)), Array.from({ length: n }, (_, i) => def(i))));
    expect(g.nodes).toHaveLength(GRAPH_MAX_NODES);
    expect(g.truncated).toBe(true);
    expect(g.total).toBe(n);
    expect(g.edges).toHaveLength(GRAPH_MAX_NODES - 1);
  });
  it("sıra dışı gelen adımlar indekse göre dizilir", () => {
    const g = buildKaputGraph(seq([step(1), step(0)], [def(0), def(1)]));
    expect(g.levels).toEqual([["s0"], ["s1"]]);
  });
});

describe("Kaput DAG görünümü", () => {
  const chain = () => seq([step(0), step(1), step(2)], [def(0), def(1), def(2)]);
  it("SVG role=img + özet etiketi, düğüm/kenar sayısı, liste yedeği bağımlılıkları söyler", () => {
    const h = render(chain());
    expect(h).toContain('role="img"');
    expect(h).toContain('aria-label="app.jobs.kaput.dag.summary{"steps":3,"levels":3,"edges":2}"');
    expect(h.match(/data-testid="job-kaput-dag-node"/g)).toHaveLength(3);
    expect(h.match(/data-testid="job-kaput-dag-edge"/g)).toHaveLength(2);
    expect(h).toContain('app.jobs.kaput.dag.dependsOn{"steps":"2"}');
    expect(h).toContain("app.jobs.kaput.dag.noDeps");
    expect(h).toContain('tabindex="0"');
  });
  it("durum yalnız renkle değil: düğümde glif ve durum metni", () => {
    const h = render(seq([step(0), step(1, { status: "FAILED" })], [def(0), def(1)]));
    expect(h).toContain("✓ app.jobs.kaput.stepStatus.completed");
    expect(h).toContain("✕ app.jobs.kaput.stepStatus.failed");
  });
  it("veri yok: açık durum + sıralı liste, SVG yok", () => {
    const h = render(parseKaput({ steps: [step(0), step(1)] }));
    expect(h).toContain('data-testid="job-kaput-dag-nodata"');
    expect(h).not.toContain("<svg");
    expect(h).toContain('data-testid="job-kaput-dag-list"');
    expect(h).not.toContain("app.jobs.kaput.dag.dependsOn");
  });
  it("adım adları maskelenir (grafikte ve listede)", () => {
    const secret = "sk-abcdefghijklmnop1234";
    const h = render(seq([step(0, { name: `anahtar ${secret}` })], [{ name: `anahtar ${secret}`, order: 0 }]));
    expect(h).not.toContain(secret);
    expect(h).toContain("[gizlendi]");
  });
  it("tutarsız veri notu ve kırpma notu görünür", () => {
    expect(render(parseKaput({ steps: [step(0), step(1, { dependsOn: ["yok"] })] }))).toContain('data-testid="job-kaput-dag-inconsistent"');
    const n = GRAPH_MAX_NODES + 3;
    const h = render(seq(Array.from({ length: n }, (_, i) => step(i)), Array.from({ length: n }, (_, i) => def(i))));
    expect(h).toContain(`app.jobs.kaput.dag.truncated{"shown":${GRAPH_MAX_NODES},"total":${n}}`);
    expect(h.match(/data-testid="job-kaput-dag-node"/g)).toHaveLength(GRAPH_MAX_NODES);
  });
  it("RTL (ar): grup dir=rtl, metin sağa hizalı, kenarlar sağdan sola akar", () => {
    const h = render(chain(), "ar");
    expect(h).toContain('dir="rtl"');
    expect(h).toContain('text-anchor="end"');
    const ltr = render(chain(), "en");
    expect(ltr).not.toContain('text-anchor="end"');
  });
  it("hiç adım yoksa DAG bölümü çizilmez", () => {
    expect(render(parseKaput({ steps: [] }))).not.toContain("job-kaput-dag");
  });
});

const seqT = (steps: unknown[], defs: unknown[], times: { updatedAt?: string; startedAt?: string; createdAt?: string }) =>
  parseKaput({ steps, startedAt: times.startedAt, createdAt: times.createdAt, pipeline: { pipelineType: "SEQUENTIAL", steps: defs, updatedAt: times.updatedAt } });

describe("DAG: tanım değişimi, retry, order, kapı boşluğu", () => {
  const defs = [def(0), def(1), def(2)];
  const rows = () => [step(0), step(1), step(2)];
  it("hat koşudan sonra değiştiyse çıkarım kapanır ve not görünür", () => {
    const k = seqT(rows(), defs, { startedAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" });
    const g = buildKaputGraph(k);
    expect(g).toMatchObject({ source: "none", changed: true, nodes: [], edges: [] });
    const h = render(k);
    expect(h).toContain('data-testid="job-kaput-dag-changed"');
    expect(h).not.toContain("<svg");
  });
  it("hat koşudan önce güncellenmişse doğrulanmış grafik; startedAt yoksa createdAt kullanılır", () => {
    const g = buildKaputGraph(seqT(rows(), defs, { startedAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z" }));
    expect(g).toMatchObject({ source: "order", unverified: false });
    expect(buildKaputGraph(seqT(rows(), defs, { createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" })).changed).toBe(true);
  });
  it("zaman alanları yoksa grafik 'güncel tanıma göre' notuyla gelir", () => {
    const k = seqT(rows(), defs, {});
    expect(buildKaputGraph(k).unverified).toBe(true);
    expect(render(k)).toContain('data-testid="job-kaput-dag-unverified"');
    expect(render(seqT(rows(), defs, { startedAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z" }))).not.toContain("job-kaput-dag-unverified");
  });
  it("retry: aynı stepIndex için en yeni satır seçilir, graf tutarlı kalır", () => {
    const g = buildKaputGraph(seqT([step(0), step(1, { id: "eski", createdAt: "2026-11-01T10:00:00Z", status: "FAILED" }), step(1, { id: "yeni", createdAt: "2026-11-01T10:05:00Z" }), step(2)], defs, {}));
    expect(g.consistent).toBe(true);
    expect(g.nodes.map((n) => n.id)).toEqual(["s0", "yeni", "s2"]);
    expect(g.total).toBe(3);
    const h = render(seqT([step(0), step(1, { id: "eski", createdAt: "2026-11-01T10:00:00Z", status: "FAILED" }), step(1, { id: "yeni", createdAt: "2026-11-01T10:05:00Z" }), step(2)], defs, {}));
    expect(h.match(/data-testid="job-kaput-dag-node"/g)).toHaveLength(3);
    expect(h).not.toContain("✕");
  });
  it("retry: createdAt eşitse büyük id kazanır", () => {
    const g = buildKaputGraph(seqT([step(0), step(0, { id: "z9" })], [def(0)], {}));
    expect(g.nodes.map((n) => n.id)).toEqual(["z9"]);
  });
  it("stepIndex >= tanım sayısı: çıkarım yok, tutarsız", () => {
    const g = buildKaputGraph(seqT([step(0), step(1), step(2), step(3)], defs, {}));
    expect(g).toMatchObject({ source: "none", consistent: false });
  });
  it("order sayı değilse (metin/NaN) çıkarım kapanır; negatif order runner gibi ham değerle sıralanır", () => {
    expect(buildKaputGraph(seqT([step(0), step(1)], [def(0), { name: "Adım 1", order: "2" }], {}))).toMatchObject({ source: "none", consistent: false });
    const g = buildKaputGraph(seqT([step(0), step(1)], [def(0, 5), def(1, -3)], {}));
    // order sırası: Adım 1 (-3) önce, Adım 0 (5) sonra → stepIndex 0 = Adım 1; ad eşleşmez → kapanır
    expect(g.source).toBe("none");
    const ok = buildKaputGraph(seqT([step(0, { name: "Adım 1" }), step(1, { name: "Adım 0" })], [def(0, 5), def(1, -3)], {}));
    expect(ok.source).toBe("order");
    expect(ok.edges).toEqual([{ from: "s0", to: "s1" }]);
  });
  it("ara grubun hiç satırı yoksa tutarsız sayılır (bağlama yok); sondaki eksik grup normal", () => {
    expect(buildKaputGraph(seqT([step(0), step(2)], [def(0), def(1), def(2)], {}))).toMatchObject({ source: "none", consistent: false });
    expect(buildKaputGraph(seqT([step(0)], [def(0), def(1), def(2)], {}))).toMatchObject({ source: "order", consistent: true });
  });
  it("ok ucu: tüm kenarlarda marker-end; RTL'de kenar sağdan sola, LTR'de soldan sağa", () => {
    const k = seqT(rows(), defs, {});
    const xs = (h: string) => [...h.matchAll(/data-testid="job-kaput-dag-edge" d="M([\d.]+) [\d.]+ C[^"]*? ([\d.]+) [\d.]+"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const ltr = render(k, "en"), rtl = render(k, "ar");
    expect(ltr.match(/marker-end="url\(#[A-Za-z0-9]+arrow\)"/g)).toHaveLength(2);
    expect(ltr).toContain("<marker");
    expect(xs(ltr).every(([a, b]) => a < b)).toBe(true);
    expect(xs(rtl)).toHaveLength(2);
    expect(xs(rtl).every(([a, b]) => a > b)).toBe(true);
  });
  it("geniş harf/CJK ad düğümden taşmaz: görsel genişliğe göre kırpılır, clipPath var", () => {
    const long = "日本語のとても長いステップ名前です。さらに長く";
    const out = clipWide(`1. ${long}`, 18);
    expect(out.endsWith("…")).toBe(true);
    expect(Array.from(out.replace("…", "")).reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)).toBeLessThanOrEqual(18);
    const h = render(seq([step(0, { name: long })], [{ name: long, order: 0 }]));
    expect(h).toContain("<clipPath");
    expect(h).toContain('clip-path="url(#');
    expect(clipWide("kısa", 18)).toBe("kısa");
  });
});

describe("DAG i18n", () => {
  it("15 dilde dag anahtar kümesi eşit", () => {
    const dir = join(__dirname, "../../messages");
    const files = ["ar", "de", "en", "es-419", "es", "fr", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "tr", "zh-Hans"];
    const sets = files.map((f) => Object.keys(JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8")).app.jobs.kaput.dag).sort().join(","));
    expect(files).toHaveLength(15);
    expect(new Set(sets).size).toBe(1);
    expect(sets[0].split(",")).toHaveLength(13);
  });
  it("en dışındaki dillerde dag değerleri boş değil ve İngilizceyle aynı değil; changed nötr (değişti iddiası yok) ", () => {
    const dir = join(__dirname, "../../messages");
    const load = (f: string) => JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8")).app.jobs.kaput.dag as Record<string, string>;
    const en = load("en");
    for (const f of ["ar", "de", "es-419", "es", "fr", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "tr", "zh-Hans"]) {
      const d = load(f);
      for (const [k, v] of Object.entries(en)) {
        expect(typeof d[k] === "string" && d[k].trim().length > 0, `${f}.${k} boş`).toBe(true);
        expect(d[k], `${f}.${k} İngilizce kalmış`).not.toBe(v);
      }
    }
    expect(load("es-419")).toEqual(load("es"));
    expect(en.changed).not.toMatch(/changed after/i);
  });
});

describe("DAG: referans zamanı = ilk adım createdAt", () => {
  const defs = [def(0), def(1)];
  const at = (iso: string, extra: Record<string, unknown> = {}) => ({ createdAt: iso, ...extra });
  it("resume sonrası startedAt ileri alınmış; ilk adım createdAt hat güncellemesinden önce → kapanır", () => {
    const k = seqT([step(0, at("2026-11-01T10:00:00Z")), step(1, at("2026-11-01T10:01:00Z"))], defs, { startedAt: "2026-11-05T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" });
    expect(k.times?.runStartedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(buildKaputGraph(k)).toMatchObject({ source: "none", changed: true });
  });
  it("u === r sınırı: kapanmaz", () => {
    const k = seqT([step(0, at("2026-11-01T10:00:00Z")), step(1, at("2026-11-01T10:01:00Z"))], defs, { updatedAt: "2026-11-01T10:00:00Z" });
    expect(buildKaputGraph(k)).toMatchObject({ source: "order", unverified: false });
    expect(buildKaputGraph(k).changed).toBeUndefined();
  });
  it("adım createdAt yoksa startedAt ?? createdAt'e düşer", () => {
    const k = seqT([step(0), step(1)], defs, { startedAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" });
    expect(k.times?.runStartedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(buildKaputGraph(k).changed).toBe(true);
  });
  it("geçersiz ISO: referans yok → unverified, kapanmaz", () => {
    const k = seqT([step(0, at("bozuk")), step(1, at("bozuk"))], defs, { startedAt: "yok", updatedAt: "2026-11-02T10:00:00Z" });
    expect(k.times?.runStartedAt).toBeNull();
    expect(buildKaputGraph(k)).toMatchObject({ source: "order", unverified: true });
    const k2 = seqT([step(0, at("2026-11-01T10:00:00Z")), step(1)], defs, { updatedAt: "geçersiz" });
    expect(buildKaputGraph(k2)).toMatchObject({ source: "order", unverified: true });
  });
});

describe("buildKaputGraph — BRA-P2-04 sunucu graphSource alanı", () => {
  it("SEQUENTIAL sunucu dependsOn'u: hat tanımına bakmaz (tanım değişmiş olsa da kapanış yok)", () => {
    const k = parseKaput({
      steps: [step(0, { graphSource: "order", dependsOn: [] }), step(1, { graphSource: "order", dependsOn: ["s0"] })],
      pipeline: { pipelineType: "SEQUENTIAL", updatedAt: "2099-01-01T00:00:00Z", steps: [{ name: "başka", order: 0 }] },
    });
    const g = buildKaputGraph(k);
    expect(g.source).toBe("api");
    expect(g.changed).toBeUndefined();
    expect(g.edges).toEqual([{ from: "s0", to: "s1" }]);
  });
  it("HIERARCHICAL: delegeler manager adımına bağlı çizilir", () => {
    const g = buildKaputGraph(parseKaput({
      steps: [step(0, { graphSource: "manager", dependsOn: [] }), step(1, { graphSource: "manager", dependsOn: ["s0"] }), step(2, { graphSource: "manager", dependsOn: ["s0"] })],
      pipeline: { pipelineType: "HIERARCHICAL" },
    }));
    expect(g.source).toBe("api");
    expect(g.levels).toEqual([["s0"], ["s1", "s2"]]);
  });
  it("sunucu 'unavailable': kenar uydurulmaz; yalnız definition_changed kapanış notu verir", () => {
    const mk = (reason: string) => buildKaputGraph(parseKaput({ steps: [step(0, { graphSource: "unavailable", graphReason: reason, dependsOn: null })], pipeline: { pipelineType: "SEQUENTIAL", steps: [{ name: "Adım 0", order: 0 }] } }));
    expect(mk("definition_changed")).toMatchObject({ source: "none", changed: true });
    expect(mk("no_manager")).toMatchObject({ source: "none", changed: false });
  });
  it("alan yoksa eski davranış (hat tanımından çıkarım) korunur", () => {
    expect(buildKaputGraph(seq([step(0), step(1)], [def(0), def(1)])).source).toBe("order");
  });
});
