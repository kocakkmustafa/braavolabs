/**
 * BRA-P2-04 — `GET /runs/:id` adım grafiği alanları (saf, DB'siz; migration yok).
 *
 * Her adıma EK alanlar (geriye uyumlu; mevcut alanlar değişmez):
 *  - order        : SEQUENTIAL'da hat tanımındaki `order` değeri; aksi null.
 *  - group        : SEQUENTIAL'da yoğun paralel-grup sırası (0..n); aksi null.
 *  - dependsOn    : bağımlı olunan adım satır id'leri (string[]) ya da null = bilinmiyor (kenar uydurulmaz).
 *  - parentStepId : HIERARCHICAL'da delegasyonu başlatan manager adımının id'si; aksi null.
 *  - graphSource  : "order" | "manager" | "unavailable".
 *  - graphReason  : yalnız "unavailable": "definition_changed" | "definition_mismatch" | "inconsistent" | "no_definition" | "no_manager".
 *
 * Kaynaklar (RunStep'te bağımlılık sütunu yok):
 *  - SEQUENTIAL: runner.ts aynı `order` = paralel grup, her grup bir öncekinin tamamını bekler. Hat tanımı koşudan sonra
 *    değiştiyse (pipeline.updatedAt > ilk adım createdAt) ya da adlar uyuşmuyorsa çıkarım YAPILMAZ ("unavailable").
 *  - HIERARCHICAL: çalışma anında üretilen `delegate:*` adımlarının gerçek üst-adımı `manager:dispatch` (stepIndex 0) satırıdır.
 *    Delegasyonlar arası sıra manager LLM'inin kararıdır ve kaydedilmez → delegeler arası bağımlılık YOK (yalnız üst-adım).
 * Aynı stepIndex için birden çok satır (retry/devralma) varsa en yeni satır (createdAt, eşitse büyük id) bağımlılık hedefidir.
 */

export interface GraphStepInput { id: string; stepIndex: number; name: string; createdAt: Date | string | null }
export interface GraphPipelineInput { pipelineType: string; steps: unknown; updatedAt: Date | string | null }

export type StepGraphSource = "order" | "manager" | "unavailable";
export type StepGraphReason = "definition_changed" | "definition_mismatch" | "inconsistent" | "no_definition" | "no_manager";
export interface StepGraphFields {
  order: number | null;
  group: number | null;
  dependsOn: string[] | null;
  parentStepId: string | null;
  graphSource: StepGraphSource;
  graphReason?: StepGraphReason;
}

const ms = (d: Date | string | null): number | null => {
  if (d === null) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : null;
};

const unavailable = (reason: StepGraphReason): StepGraphFields =>
  ({ order: null, group: null, dependsOn: null, parentStepId: null, graphSource: "unavailable", graphReason: reason });

/** stepIndex → en yeni satır. */
function latestByIndex(steps: GraphStepInput[]): Map<number, GraphStepInput> {
  const best = new Map<number, GraphStepInput>();
  for (const s of steps) {
    const cur = best.get(s.stepIndex);
    if (!cur) { best.set(s.stepIndex, s); continue; }
    const a = ms(s.createdAt) ?? 0, b = ms(cur.createdAt) ?? 0;
    if (a > b || (a === b && s.id > cur.id)) best.set(s.stepIndex, s);
  }
  return best;
}

/** Her adım id'si için grafik alanları. Boş adım listesi → boş Map. */
export function deriveStepGraph(steps: GraphStepInput[], pipeline: GraphPipelineInput): Map<string, StepGraphFields> {
  const out = new Map<string, StepGraphFields>();
  if (steps.length === 0) return out;
  const fill = (f: (s: GraphStepInput) => StepGraphFields) => { for (const s of steps) out.set(s.id, f(s)); };

  if (pipeline.pipelineType === "HIERARCHICAL") {
    const managerRow = latestByIndex(steps).get(0);
    const manager = managerRow && managerRow.name === "manager:dispatch" ? managerRow : null;
    if (!manager) { fill(() => unavailable("no_manager")); return out; }
    fill((s) => {
      if (s.id === manager.id) return { order: null, group: null, dependsOn: [], parentStepId: null, graphSource: "manager" };
      if (s.name.startsWith("delegate:")) return { order: null, group: null, dependsOn: [manager.id], parentStepId: manager.id, graphSource: "manager" };
      return { order: null, group: null, dependsOn: null, parentStepId: null, graphSource: "manager" };
    });
    return out;
  }

  if (pipeline.pipelineType !== "SEQUENTIAL" || !Array.isArray(pipeline.steps)) { fill(() => unavailable("no_definition")); return out; }

  const updated = ms(pipeline.updatedAt);
  const firstAt = steps.map((s) => ms(s.createdAt)).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  if (updated !== null && firstAt !== null && updated > firstAt) { fill(() => unavailable("definition_changed")); return out; }

  // runner.ts: `s.order ?? idx`, order'a göre kararlı sıralama; stepIndex = sıralı dizideki konum.
  const defs: Array<{ name: string; order: number }> = [];
  for (let i = 0; i < pipeline.steps.length; i++) {
    const d = pipeline.steps[i] as { name?: unknown; order?: unknown } | null;
    const o = d && typeof d === "object" ? d.order : undefined;
    const order = o === undefined || o === null ? i : o;
    if (typeof order !== "number" || !Number.isFinite(order)) { fill(() => unavailable("no_definition")); return out; }
    defs.push({ name: typeof d?.name === "string" ? d.name : "", order });
  }
  defs.sort((a, b) => a.order - b.order);
  if (!steps.every((s) => s.stepIndex >= 0 && s.stepIndex < defs.length && defs[s.stepIndex].name === s.name)) { fill(() => unavailable("definition_mismatch")); return out; }

  const orders = [...new Set(defs.map((d) => d.order))];
  const latest = [...latestByIndex(steps).values()];
  const present = new Set(latest.map((s) => defs[s.stepIndex].order));
  const lastPresent = Math.max(...present);
  // Ara grup tanımda var ama kayıtta yok (sonraki grubun kaydı var) → tutarsız.
  if (orders.some((o) => o < lastPresent && !present.has(o))) { fill(() => unavailable("inconsistent")); return out; }

  const groupOf = new Map(orders.map((o, g) => [o, g]));
  const idsByGroup = new Map<number, string[]>();
  for (const s of latest) {
    const g = groupOf.get(defs[s.stepIndex].order) as number;
    idsByGroup.set(g, [...(idsByGroup.get(g) ?? []), s.id]);
  }
  fill((s) => {
    const order = defs[s.stepIndex].order, group = groupOf.get(order) as number;
    return { order, group, dependsOn: group === 0 ? [] : [...(idsByGroup.get(group - 1) ?? [])], parentStepId: null, graphSource: "order" };
  });
  return out;
}
