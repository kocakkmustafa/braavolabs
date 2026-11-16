/**
 * BRA-P2-04 — `GET /runs/:id` adım grafiği alanları (saf, DB'siz; migration yok).
 *
 * Her adıma EK alanlar (geriye uyumlu; mevcut alanlar değişmez):
 *  - order        : SEQUENTIAL'da hat tanımındaki `order` değeri; aksi null.
 *  - group        : SEQUENTIAL'da yoğun paralel-grup sırası (0..n); aksi null.
 *  - dependsOn    : bağımlı olunan adım satır id'leri (string[]) ya da null = bilinmiyor (kenar uydurulmaz).
 *  - parentStepId : HIERARCHICAL'da delegasyonu başlatan manager adımının id'si; aksi null.
 *  - graphSource  : "order" | "manager" | "unavailable".
 *  - graphReason  : yalnız "unavailable": "definition_changed" | "definition_mismatch" | "inconsistent" | "no_definition" | "no_manager" | "unverifiable".
 *
 * Kaynaklar (RunStep'te bağımlılık sütunu yok):
 *  - SEQUENTIAL: runner.ts aynı `order` = paralel grup, her grup bir öncekinin tamamını bekler. Hat tanımı koşudan sonra
 *    değiştiyse (pipeline.updatedAt > ilk adım createdAt) ya da adlar uyuşmuyorsa çıkarım YAPILMAZ ("unavailable").
 *  - HIERARCHICAL: çalışma anında üretilen `delegate:*` adımlarının gerçek üst-adımı `manager:dispatch` (stepIndex 0) satırıdır.
 *    Delegasyonlar arası sıra manager LLM'inin kararıdır ve kaydedilmez → delegeler arası bağımlılık YOK (yalnız üst-adım).
 *
 * Kararlar (reviewer BRA-P2-04):
 *  - Zaman sezgisi: hat `updatedAt` zamanlanmış tetikte `lastRunAt` yazımıyla (runner.ts, run-claim) da ilerler. Bu yüzden "tanım
 *    değişti" YALNIZ `updatedAt` > ilk adım createdAt VE (`lastRunAt` yok ya da `updatedAt` > `lastRunAt` + 5 sn) iken verilir;
 *    yani sadece lastRunAt damgasından doğan güncelleme kapanış sayılmaz. Yapısal denetim (indeks/ad/order) her durumda uygulanır.
 *    Bilinen sınır: koşudan sonra yapılıp ardından başka bir zamanlanmış tetikle lastRunAt'e eşitlenen düzenleme yalnız yapısal
 *    denetimle yakalanır (güvenli yön: ad/indeks uyuşmazsa kenar yok).
 *  - Zaman doğrulanamıyorsa (updatedAt/createdAt null ya da geçersiz) SEQUENTIAL'da "unavailable"/"unverifiable" (kenar uydurulmaz).
 *  - Hat tanımında `name` yoksa adım satırıyla eşleşme doğrulanamaz → "unverifiable" ("" ile karşılaştırılmaz). Sayı olmayan `order`
 *    runner'da `a.order - b.order` NaN/tür dönüşümüne düşer (tanımsız davranış) → "no_definition".
 *  - HIERARCHICAL retry: her denemede yeni `manager:dispatch` (stepIndex 0) satırı yazılır; delegenin üst-adımı, createdAt'i delegeden
 *    önce/eşit olan EN YENİ manager satırıdır. Zaman karşılaştırılamazsa tek manager satırı varsa o, yoksa null.
 *  - Geçicilik: aynı gruptan henüz oluşmamış paralel adımlar `dependsOn`'da eksik görünür; satırlar oluştukça tamamlanır (canlı koşuda
 *    ara görüntü eksik olabilir, fazlası asla uydurulmaz).
 * Aynı stepIndex için birden çok satır (retry/devralma) varsa en yeni satır (createdAt, eşitse büyük id) bağımlılık hedefidir.
 */

export interface GraphStepInput { id: string; stepIndex: number; name: string; createdAt: Date | string | null }
export interface GraphPipelineInput { pipelineType: string; steps: unknown; updatedAt: Date | string | null; lastRunAt?: Date | string | null }

export type StepGraphSource = "order" | "manager" | "unavailable";
export type StepGraphReason = "definition_changed" | "definition_mismatch" | "inconsistent" | "no_definition" | "no_manager" | "unverifiable";
export interface StepGraphFields {
  order: number | null;
  group: number | null;
  dependsOn: string[] | null;
  parentStepId: string | null;
  graphSource: StepGraphSource;
  graphReason?: StepGraphReason;
}

const LAST_RUN_STAMP_SLACK_MS = 5000;
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
    const managers = steps.filter((s) => s.stepIndex === 0 && s.name === "manager:dispatch");
    if (managers.length === 0) { fill(() => unavailable("no_manager")); return out; }
    const managerFor = (d: GraphStepInput): GraphStepInput | null => {
      const dt = ms(d.createdAt);
      if (dt === null || managers.some((m) => ms(m.createdAt) === null)) return managers.length === 1 ? managers[0] : null;
      let best: GraphStepInput | null = null;
      for (const m of managers) {
        const mt = ms(m.createdAt) as number;
        if (mt > dt) continue;
        const bt = best ? (ms(best.createdAt) as number) : -Infinity;
        if (!best || mt > bt || (mt === bt && m.id > best.id)) best = m;
      }
      return best;
    };
    fill((s) => {
      if (managers.some((m) => m.id === s.id)) return { order: null, group: null, dependsOn: [], parentStepId: null, graphSource: "manager" };
      if (s.name.startsWith("delegate:")) {
        const m = managerFor(s);
        return m ? { order: null, group: null, dependsOn: [m.id], parentStepId: m.id, graphSource: "manager" } : { order: null, group: null, dependsOn: null, parentStepId: null, graphSource: "manager" };
      }
      return { order: null, group: null, dependsOn: null, parentStepId: null, graphSource: "manager" };
    });
    return out;
  }

  if (pipeline.pipelineType !== "SEQUENTIAL" || !Array.isArray(pipeline.steps)) { fill(() => unavailable("no_definition")); return out; }

  const updated = ms(pipeline.updatedAt);
  const firstAt = steps.map((s) => ms(s.createdAt)).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  if (updated === null || firstAt === null || steps.some((s) => ms(s.createdAt) === null)) { fill(() => unavailable("unverifiable")); return out; }
  const lastRun = pipeline.lastRunAt == null ? null : ms(pipeline.lastRunAt);
  // lastRunAt damgası (run-claim) updatedAt'i ilerletir; yalnız ondan doğan güncelleme tanım değişikliği sayılmaz.
  const claimOnly = lastRun !== null && updated - lastRun <= LAST_RUN_STAMP_SLACK_MS;
  if (updated > firstAt && !claimOnly) { fill(() => unavailable("definition_changed")); return out; }

  // runner.ts: `s.order ?? idx`, order'a göre kararlı sıralama; stepIndex = sıralı dizideki konum.
  const defs: Array<{ name: string | null; order: number }> = [];
  for (let i = 0; i < pipeline.steps.length; i++) {
    const d = pipeline.steps[i] as { name?: unknown; order?: unknown } | null;
    const o = d && typeof d === "object" ? d.order : undefined;
    const order = o === undefined || o === null ? i : o;
    if (typeof order !== "number" || !Number.isFinite(order)) { fill(() => unavailable("no_definition")); return out; }
    defs.push({ name: typeof d?.name === "string" ? d.name : null, order });
  }
  defs.sort((a, b) => a.order - b.order);
  if (steps.some((s) => s.stepIndex >= 0 && s.stepIndex < defs.length && defs[s.stepIndex].name === null)) { fill(() => unavailable("unverifiable")); return out; }
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
