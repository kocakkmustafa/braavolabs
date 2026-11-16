/**
 * BRA-UX-04 — prototip için SAF görünüm mantığı (I/O yok, DOM yok; vitest ile doğrudan test edilir).
 * İlke (04-design.md §5.4, §8): kaynak alan yoksa "bilgi yok" yazılır, uydurulmaz; toplu onay KAPALI;
 * tehlikeli (para ya da geri alınamaz ya da yüksek risk) onay ikinci adım ister.
 */
import type { ApprovalDetails, InboxBucket } from "@ai-company-os/core";
import type { InboxApproval, InboxApprovalGroup, InboxRun } from "../inbox";

/** Liste ucu (PR #133) `details` ekler; yoksa alanlar "bilgi yok" olur. */
export type LabApproval = InboxApproval & { details?: ApprovalDetails | null };
export type LabApprovalGroup = Omit<InboxApprovalGroup, "approvals"> & { approvals: LabApproval[] };

export type FactKey = "what" | "tool" | "permissions" | "data" | "amount" | "reversible" | "risk" | "draft";
/** `value === null` → kaynak yok: arayüz "bilgi yok" der. */
export interface Fact { key: FactKey; value: string | null }

const toNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** Kaput sayıları (maliyet, süre, token, sıra): negatif değer geçersiz → null. */
const nonNeg = (v: unknown): number | null => {
  const n = toNumber(v);
  return n !== null && n >= 0 ? n : null;
};
const joined =(list: string[] | null | undefined): string | null => (list && list.length > 0 ? list.join(", ") : null);

export function usd(n: number, locale = "tr-TR"): string {
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n); } catch { return `$${n}`; }
}

/** Onay anlama (T4): ne yapacak / hangi araç / yetki / veri / tutar / geri alma / taslak. */
export function approvalFacts(a: LabApproval): Fact[] {
  const d = a.details ?? null;
  const amount = toNumber(a.amountUsd);
  return [
    { key: "what", value: a.description?.trim() || null },
    { key: "tool", value: a.metadata?.toolName?.trim() || null },
    { key: "permissions", value: joined(d?.permissions) },
    { key: "data", value: joined(d?.dataTransfer) },
    { key: "amount", value: amount !== null && amount > 0 ? usd(amount) : "—" },
    { key: "reversible", value: d?.reversible === true ? "yes" : d?.reversible === false ? "no" : null },
    { key: "risk", value: d?.risk ?? null },
    { key: "draft", value: a.artifact?.body ? a.artifact.body : null },
  ];
}

export function approvalIsDangerous(a: LabApproval): boolean {
  const amount = toNumber(a.amountUsd);
  return (amount !== null && amount > 0) || a.details?.risk === "high" || a.details?.reversible === false;
}

export const CONFIRM_PHRASE = "Onaylıyorum";
const norm = (s: string) => s.trim().toLocaleLowerCase("tr-TR");
/** Tehlikeli onayın ikinci adımı: ifade birebir (büyük/küçük harf duyarsız) + dolu sebep. Reddetmek ikinci adım istemez. */
export function confirmOk(input: { phrase: string; reason: string }): boolean {
  return norm(input.phrase) === norm(CONFIRM_PHRASE) && input.reason.trim().length >= 3;
}

/** Toplu onay KAPALI (§5.4): "düşük risk" etiketi bugün tam güvenilir değil (03b(b)); her onay tek tek kararlanır. */
export const BATCH_APPROVE_ENABLED = false;

export type BucketMap = Record<InboxBucket, InboxRun[]>;
export function groupRuns(runs: readonly InboxRun[]): BucketMap {
  const out: BucketMap = { working: [], needs_approval: [], done: [], stuck: [] };
  for (const r of runs) if (r.bucket && out[r.bucket]) out[r.bucket].push(r);
  return out;
}

export interface Expected { approvals: number; stuck: number }
export function expectedFromYou(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): Expected {
  return { approvals: groups.reduce((n, g) => n + g.approvals.length, 0), stuck: runs.filter((r) => r.bucket === "stuck").length };
}

/** Onay grupları koşu kimliğine bağlıdır: seçili şirketin koşularına ait olanlar (çok şirketli canlı kip). */
export function groupsForRuns(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): LabApprovalGroup[] {
  const ids = new Set(runs.map((r) => r.id));
  return groups.filter((g) => ids.has(g.runId));
}

/** Listelenen işlerin maliyet toplamı. NOT: haftalık toplam alanı YOK (§5.3): etiket "listelenen işler" der. */
export function listedCostUsd(runs: readonly InboxRun[]): number {
  return runs.reduce((n, r) => n + (toNumber(r.costUsd) ?? 0), 0);
}

export interface CompanyLine { running: number; approvals: number; stuck: number; done: number; listedCostUsd: number }
export function companyLine(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): CompanyLine {
  const m = groupRuns(runs);
  return { running: m.working.length, approvals: groups.reduce((n, g) => n + g.approvals.length, 0), stuck: m.stuck.length, done: m.done.length, listedCostUsd: listedCostUsd(runs) };
}

/* ── Kaputu Aç: `GET /runs/:id` gövdesinin savunmacı okuması (adım + araç çağrısı + maliyet; model/yetki dökümü API ister) ── */
export interface KaputToolCall { id: string; toolName: string; status: string; durationMs: number | null; error: string | null }
/** BRA-P1-01-N1 — adımı fiilen sunan model (`output.provider|model`) ve kip (`modelMode`, `modeDetail`). Alan yoksa null (uydurulmaz). */
export type KaputModelMode = "DIRECT" | "CASCADE" | "COMPARE";
export interface KaputModel { provider: string | null; model: string | null; mode: KaputModelMode | null; tried: string[] }
/** Adım olay günlüğü: yalnız `startedAt`/`completedAt` zaman damgaları (koşu seviyesinde etkinlik günlüğü ucu yok). */
export interface KaputLogEvent { kind: "started" | "ended"; at: string }
export interface KaputTokens { input: number | null; output: number | null }
export interface KaputStep { id: string; index: number; name: string; agentRole: string | null; status: string; costUsd: number | null; durationMs: number | null; reasoning: string | null; toolCalls: KaputToolCall[]; error?: string | null; modelInfo?: KaputModel | null; log?: KaputLogEvent[]; tokens?: KaputTokens | null; dependsOn?: string[] | null; createdAt?: string | null }
/** BRA-P1-01-N2 — işin hattı tanımından yalnız ad ve sıra (`order`); `GET /runs/:id` yanıtındaki `pipeline.steps` + `pipeline.pipelineType`. */
export interface KaputPipelineDef { name: string; order: number | null }
/** Hat/koşu zamanları (ISO): hat kaydının koşudan sonra güncellenip güncellenmediğini sınamak için (`pipeline.updatedAt`, koşunun ilk adım satırı createdAt; adım yoksa startedAt ?? createdAt). `updatedAt` tanım dışı yazımlarla (lastRunAt) da ilerler: "güncellendi" ≠ "tanım değişti". */
export interface KaputTimes { pipelineUpdatedAt: string | null; runStartedAt: string | null }
/** `handoffCount` null = okunamadı/yok (uydurulmaz). */
export interface Kaput { steps: KaputStep[]; totalCostUsd: number | null; toolCallCount: number; handoffCount: number | null; runError?: string | null; budgetUsd?: number | null; pipelineType?: string | null; pipelineDefs?: KaputPipelineDef[] | null; times?: KaputTimes | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const MODES: readonly string[] = ["DIRECT", "CASCADE", "COMPARE"];
const isoTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** `modeDetail` içindeki denenen model adları (CASCADE attempts / COMPARE candidates); yinelenenler elenir, en çok 5. */
function triedModels(detail: unknown): string[] {
  if (!isObj(detail)) return [];
  const rows = [detail.attempts, detail.candidates].flatMap((x) => (Array.isArray(x) ? x : [])).filter(isObj);
  const out: string[] = [];
  for (const r of rows) {
    if (r.skipped) continue;
    const name = str(r.actualModel) ?? str(r.model);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 5);
}
export function parseKaputModel(s: Record<string, unknown>): KaputModel | null {
  const out = isObj(s.output) ? s.output : null;
  const provider = out ? str(out.provider) : null;
  const model = out ? str(out.model) : null;
  const rawMode = typeof s.modelMode === "string" ? s.modelMode.toUpperCase() : null;
  const mode = rawMode && MODES.includes(rawMode) ? (rawMode as KaputModelMode) : null;
  const tried = triedModels(s.modeDetail);
  if (!provider && !model && !mode && tried.length === 0) return null;
  return { provider, model, mode, tried };
}

const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

export function parseKaput(raw: unknown): Kaput {
  if (!isObj(raw)) return { steps: [], totalCostUsd: null, toolCallCount: 0, handoffCount: null };
  const steps: KaputStep[] = (Array.isArray(raw.steps) ? raw.steps : []).filter(isObj).map((s, i) => ({
    id: str(s.id) ?? `step-${i}`,
    index: nonNeg(s.stepIndex) ?? i,
    name: str(s.name) ?? str(s.agentRole) ?? `#${i + 1}`,
    agentRole: str(s.agentRole),
    status: (str(s.status) ?? "unknown").toLowerCase(),
    costUsd: nonNeg(s.costUsd),
    durationMs: nonNeg(s.durationMs),
    reasoning: str(s.reasoning),
    error: str(s.error),
    modelInfo: parseKaputModel(s),
    log: [
      ...(isoTime(s.startedAt) ? [{ kind: "started" as const, at: isoTime(s.startedAt) as string }] : []),
      ...(isoTime(s.completedAt) ? [{ kind: "ended" as const, at: isoTime(s.completedAt) as string }] : []),
    ],
    createdAt: isoTime(s.createdAt),
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map((d) => (typeof d === "string" ? d : "")) : null,
    tokens: nonNeg(s.promptTokens) === null && nonNeg(s.completionTokens) === null ? null : { input: nonNeg(s.promptTokens), output: nonNeg(s.completionTokens) },
    toolCalls: (Array.isArray(s.toolCalls) ? s.toolCalls : []).filter(isObj).map((c, j) => ({
      id: str(c.id) ?? `call-${i}-${j}`,
      toolName: str(c.toolName) ?? "?",
      status: (str(c.status) ?? "completed").toLowerCase(),
      durationMs: nonNeg(c.durationMs),
      error: str(c.error),
    })),
  }));
  return { steps, totalCostUsd: nonNeg(raw.costUsd), toolCallCount: steps.reduce((n, s) => n + s.toolCalls.length, 0), handoffCount: null, runError: str(raw.error), budgetUsd: positive(toNumber(raw.budgetUsd)), ...parsePipeline(raw.pipeline), times: { pipelineUpdatedAt: isObj(raw.pipeline) ? isoTime(raw.pipeline.updatedAt) : null, runStartedAt: firstStepAt(steps) ?? isoTime(raw.startedAt) ?? isoTime(raw.createdAt) } };
}

/** Koşunun referans zamanı: ilk adım satırının createdAt'i (run.startedAt resume/rerun'da yeniden yazılır, güvenilmez; adım yoksa geri düşülür). */
function firstStepAt(steps: KaputStep[]): string | null {
  const ts = steps.map((s) => s.createdAt).filter((x): x is string => !!x).sort();
  return ts[0] ?? null;
}

/** Hat tanımı: `order` yoksa dizi sırası (runner.ts: `s.order ?? idx`). Dizi değilse null (uydurulmaz). */
function parsePipeline(p: unknown): { pipelineType: string | null; pipelineDefs: KaputPipelineDef[] | null } {
  if (!isObj(p)) return { pipelineType: null, pipelineDefs: null };
  const defs = Array.isArray(p.steps)
    // runner.ts: `s.order ?? idx` (ham değer; negatif geçerli). Sayı olmayan/sonlu olmayan order → null (çıkarım kapanır).
    ? p.steps.map((d, i) => {
      const o = isObj(d) ? d.order : undefined;
      return { name: isObj(d) ? (str(d.name) ?? "") : "", order: o === undefined || o === null ? i : typeof o === "number" && Number.isFinite(o) ? o : null };
    })
    : null;
  return { pipelineType: str(p.pipelineType)?.toUpperCase() ?? null, pipelineDefs: defs };
}

/* ── BRA-P1-01-N2 — adım bağımlılık grafiği (DAG) ──
 * Kaynak bulgusu: `RunStep` satırında dependsOn/parent/dal alanı YOK. Bağımlılık yalnız (a) adım `dependsOn` taşırsa (bugün taşımaz),
 * ya da (b) `pipelineType=SEQUENTIAL` ve hat tanımı adlarla eşleşirse `order` gruplarından çıkarılır (runner.ts: aynı order = paralel,
 * bir sonraki grup öncekinin tamamını bekler). HIERARCHICAL, tanım yok ya da ad uyuşmazlığı → "none" (kenar uydurulmaz). */
export const GRAPH_MAX_NODES = 50;
export type KaputGraphSource = "api" | "order" | "none";
export interface KaputGraphNode { id: string; index: number; level: number }
export interface KaputGraph {
  source: KaputGraphSource;
  nodes: KaputGraphNode[];
  edges: Array<{ from: string; to: string }>;
  /** level → düğüm kimlikleri */
  levels: string[][];
  /** false: bilinmeyen kimlik, kendine/döngü kenarı ya da hat tanımı uyuşmazlığı bulundu (kenar atlandı) */
  consistent: boolean;
  total: number;
  truncated: boolean;
  /** true: hat tanımı koşuyla karşılaştırılamadı (updatedAt/başlangıç zamanı yok); grafik GÜNCEL tanıma göre */
  unverified?: boolean;
  /** true: hat tanımı koşudan sonra değişti → çıkarım kapatıldı */
  changed?: boolean;
}

const emptyGraph = (total: number, consistent = true): KaputGraph => ({ source: "none", nodes: [], edges: [], levels: [], consistent, total, truncated: total > GRAPH_MAX_NODES });

/** Kenarlardan (yalnız bilinen kimlikler) topolojik seviye (en uzun yol). Döngüdeki/ona bağlı kalan düğümler arası kenarlar atılır. */
function layer(ids: string[], edges: Array<{ from: string; to: string }>): { levels: Map<string, number>; edges: Array<{ from: string; to: string }>; cyclic: boolean } {
  const run = (es: Array<{ from: string; to: string }>) => {
    const indeg = new Map(ids.map((i) => [i, 0]));
    for (const e of es) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const level = new Map<string, number>();
    let queue = ids.filter((i) => indeg.get(i) === 0);
    queue.forEach((i) => level.set(i, 0));
    while (queue.length) {
      const next: string[] = [];
      for (const id of queue) for (const e of es) if (e.from === id) {
        level.set(e.to, Math.max(level.get(e.to) ?? 0, (level.get(id) ?? 0) + 1));
        indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1);
        if (indeg.get(e.to) === 0) next.push(e.to);
      }
      queue = next;
    }
    return { level, done: new Set(ids.filter((i) => indeg.get(i) === 0)) };
  };
  let { level, done } = run(edges);
  if (done.size === ids.length) return { levels: level, edges, cyclic: false };
  const stuck = new Set(ids.filter((i) => !done.has(i)));
  const kept = edges.filter((e) => !(stuck.has(e.from) && stuck.has(e.to)));
  level = run(kept).level;
  return { levels: level, edges: kept, cyclic: true };
}

/** Aynı stepIndex için birden çok satır (retry/devralma): en yeni createdAt, eşitse büyük id. */
function latestPerIndex(steps: KaputStep[]): KaputStep[] {
  const best = new Map<number, KaputStep>();
  for (const s of steps) {
    const cur = best.get(s.index);
    if (!cur) { best.set(s.index, s); continue; }
    const a = s.createdAt ?? "", b = cur.createdAt ?? "";
    if (a > b || (a === b && s.id > cur.id)) best.set(s.index, s);
  }
  return [...best.values()].sort((x, y) => x.index - y.index);
}

export function buildKaputGraph(k: Pick<Kaput, "steps" | "pipelineType" | "pipelineDefs" | "times">): KaputGraph {
  let steps = [...k.steps].sort((a, b) => a.index - b.index);
  if (steps.length === 0) return emptyGraph(0);
  const usesApi = steps.some((s) => s.dependsOn);
  if (!usesApi && k.pipelineType === "SEQUENTIAL" && k.pipelineDefs) {
    // Çıkarım güncel hat tanımına dayanır: koşudan sonra değişmişse kapat. Zaman yoksa doğrulanamaz (unverified).
    const u = k.times?.pipelineUpdatedAt ?? null, r = k.times?.runStartedAt ?? null;
    if (u && r && u > r) return { ...emptyGraph(steps.length), changed: true };
    steps = latestPerIndex(steps);
  }
  const total = steps.length;
  const shown = steps.slice(0, GRAPH_MAX_NODES);
  const truncated = total > shown.length;
  const ids = shown.map((s) => s.id);
  const known = new Set(ids);
  let consistent = true;
  let source: KaputGraphSource = "none";
  let edges: Array<{ from: string; to: string }> = [];
  const order = new Map<string, number>();
  let unverified = false;

  if (usesApi) {
    // (a) API bağımlılık verir; bilinmeyen/kendine kenar atlanır.
    source = "api";
    const seen = new Set<string>();
    for (const s of shown) for (const d of s.dependsOn ?? []) {
      const key = `${d}\u0000${s.id}`;
      if (!known.has(d) || d === s.id) { consistent = false; continue; }
      if (!seen.has(key)) { seen.add(key); edges.push({ from: d, to: s.id }); }
    }
  } else if (k.pipelineType === "SEQUENTIAL" && k.pipelineDefs) {
    // (b) aynı order = paralel grup; her grup bir öncekinin tamamına bağlı.
    if (k.pipelineDefs.some((d) => d.order === null)) return emptyGraph(total, false);
    const defs = k.pipelineDefs.map((d, i) => ({ name: d.name, order: d.order as number, i })).sort((a, b) => a.order - b.order || a.i - b.i);
    if (!steps.every((s) => s.index < defs.length && defs[s.index].name === s.name)) return emptyGraph(total, false);
    source = "order";
    for (const s of steps) order.set(s.id, defs[s.index].order);
    // Ara grubun (tanımda var, kayıtta yok ama sonraki grubun kaydı var) boşluğu = kapı hatası/tutarsız: çıkarım yok.
    const present = new Set(steps.map((s) => order.get(s.id) as number));
    const defOrders = [...new Set(defs.map((d) => d.order))];
    const lastPresent = Math.max(...present);
    if (defOrders.some((o) => o < lastPresent && !present.has(o))) return emptyGraph(total, false);
    unverified = !(k.times?.pipelineUpdatedAt && k.times?.runStartedAt);
    const orders = [...new Set(shown.map((s) => order.get(s.id) as number))].sort((a, b) => a - b);
    for (let g = 1; g < orders.length; g++) {
      for (const to of shown.filter((s) => order.get(s.id) === orders[g])) {
        for (const from of shown.filter((s) => order.get(s.id) === orders[g - 1])) edges.push({ from: from.id, to: to.id });
      }
    }
  } else {
    return emptyGraph(total);
  }

  const res = layer(ids, edges);
  if (res.cyclic) consistent = false;
  const levels: string[][] = [];
  const nodes = shown.map((s) => {
    const level = res.levels.get(s.id) ?? 0;
    (levels[level] ??= []).push(s.id);
    return { id: s.id, index: s.index, level };
  });
  return { source, nodes, edges: res.edges, levels: Array.from(levels, (l) => l ?? []), consistent, total, truncated, unverified };
}
