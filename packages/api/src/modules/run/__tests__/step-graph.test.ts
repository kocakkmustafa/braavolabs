/** BRA-P2-04 — deriveStepGraph (saf) + GET /runs/:id'de ek alanlar. */
import { describe, it, expect } from "vitest";
import { deriveStepGraph } from "../step-graph";

const t0 = "2026-11-10T10:00:00.000Z";
const before = "2026-11-09T10:00:00.000Z";
const after = "2026-11-11T10:00:00.000Z";
const st = (id: string, stepIndex: number, name: string, createdAt: string | null = t0) => ({ id, stepIndex, name, createdAt });
const seq = (steps: unknown, updatedAt: string | null = before) => ({ pipelineType: "SEQUENTIAL", steps, updatedAt });

describe("deriveStepGraph — SEQUENTIAL", () => {
  const defs = [{ name: "a", order: 0 }, { name: "b", order: 1 }, { name: "c", order: 1 }, { name: "d", order: 2 }];
  const steps = [st("A", 0, "a"), st("B", 1, "b"), st("C", 2, "c"), st("D", 3, "d")];

  it("aynı order = paralel grup; her grup öncekinin tamamına bağlı", () => {
    const g = deriveStepGraph(steps, seq(defs));
    expect(g.get("A")).toMatchObject({ order: 0, group: 0, dependsOn: [], parentStepId: null, graphSource: "order" });
    expect(g.get("B")).toMatchObject({ order: 1, group: 1, dependsOn: ["A"] });
    expect(g.get("C")).toMatchObject({ order: 1, group: 1, dependsOn: ["A"] });
    expect(g.get("D")).toMatchObject({ order: 2, group: 2, dependsOn: ["B", "C"] });
  });

  it("order yoksa dizi sırası (runner: order ?? idx)", () => {
    const g = deriveStepGraph([st("A", 0, "a"), st("B", 1, "b")], seq([{ name: "a" }, { name: "b" }]));
    expect(g.get("B")).toMatchObject({ order: 1, group: 1, dependsOn: ["A"] });
  });

  it("retry: aynı stepIndex'te en yeni satır bağımlılık hedefi", () => {
    const g = deriveStepGraph([st("A1", 0, "a", t0), st("A2", 0, "a", "2026-11-10T10:05:00.000Z"), st("B", 1, "b", "2026-11-10T10:06:00.000Z")], seq([{ name: "a", order: 0 }, { name: "b", order: 1 }]));
    expect(g.get("B")?.dependsOn).toEqual(["A2"]);
  });

  it("tanım koşudan sonra değiştiyse çıkarım yok (definition_changed)", () => {
    const g = deriveStepGraph(steps, seq(defs, after));
    expect(g.get("B")).toMatchObject({ dependsOn: null, order: null, group: null, graphSource: "unavailable", graphReason: "definition_changed" });
  });

  it("ad uyuşmazlığı → definition_mismatch; ara grup boşluğu → inconsistent; geçersiz order → no_definition", () => {
    expect(deriveStepGraph(steps, seq(defs.map((d) => ({ ...d, name: "x" })))).get("A")?.graphReason).toBe("definition_mismatch");
    expect(deriveStepGraph([st("A", 0, "a"), st("D", 3, "d")], seq(defs)).get("A")?.graphReason).toBe("inconsistent");
    expect(deriveStepGraph([st("A", 9, "a")], seq(defs)).get("A")?.graphReason).toBe("definition_mismatch");
    expect(deriveStepGraph([st("A", 0, "a"), st("D", 2, "d")], seq([{ name: "a", order: 0 }, { name: "b", order: 1 }, { name: "d", order: 2 }])).get("A")?.graphReason).toBe("inconsistent");
    expect(deriveStepGraph(steps, seq([{ name: "a", order: "x" }])).get("A")?.graphReason).toBe("no_definition");
  });

  it("henüz çalışmamış sonraki grup: yalnız mevcut kayıtlar", () => {
    const g = deriveStepGraph([st("A", 0, "a")], seq(defs));
    expect(g.get("A")?.dependsOn).toEqual([]);
  });
});

describe("deriveStepGraph — HIERARCHICAL ve diğer", () => {
  const hier = { pipelineType: "HIERARCHICAL", steps: [], updatedAt: before };
  it("delegate adımlarının üst-adımı manager:dispatch; delegeler arası bağımlılık uydurulmaz", () => {
    const g = deriveStepGraph([st("M", 0, "manager:dispatch"), st("D1", 1, "delegate:x"), st("D2", 2, "delegate:y")], hier);
    expect(g.get("M")).toMatchObject({ dependsOn: [], parentStepId: null, graphSource: "manager" });
    expect(g.get("D1")).toMatchObject({ dependsOn: ["M"], parentStepId: "M", order: null, group: null });
    expect(g.get("D2")).toMatchObject({ dependsOn: ["M"], parentStepId: "M" });
  });
  it("manager satırı yoksa açık 'yok'", () => {
    const g = deriveStepGraph([st("D1", 1, "delegate:x")], hier);
    expect(g.get("D1")).toMatchObject({ dependsOn: null, parentStepId: null, graphSource: "unavailable", graphReason: "no_manager" });
  });
  it("adım yok → boş; bilinmeyen tip → no_definition", () => {
    expect(deriveStepGraph([], hier).size).toBe(0);
    expect(deriveStepGraph([st("A", 0, "a")], { pipelineType: "X", steps: [], updatedAt: null }).get("A")?.graphReason).toBe("no_definition");
  });
});
