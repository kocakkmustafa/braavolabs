import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import KaputPanel from "../../components/job/KaputPanel";
import type { T } from "../../components/inbox/InboxParts";
import { buildKaputGraph, parseKaput, GRAPH_MAX_NODES, type Kaput } from "../ux-lab/facts";

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

describe("DAG i18n", () => {
  it("15 dilde dag anahtar kümesi eşit", () => {
    const dir = join(__dirname, "../../messages");
    const files = ["ar", "de", "en", "es-419", "es", "fr", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "tr", "zh-Hans"];
    const sets = files.map((f) => Object.keys(JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8")).app.jobs.kaput.dag).sort().join(","));
    expect(files).toHaveLength(15);
    expect(new Set(sets).size).toBe(1);
    expect(sets[0].split(",")).toHaveLength(11);
  });
});
