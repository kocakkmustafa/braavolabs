/**
 * BRA-UX-05g — Ajanlar ekranının saf mantığı. YALNIZ var olan uçlar: `GET /companies/:id/agents`,
 * `POST /companies/:id/agents/compose/draft` (kayıt YOK) ve `POST …/compose/confirm` (`{draft}`, LLM yok; kaydeder).
 * Taslak istemcide tutulur; confirm yalnız `confirmDraft` ile (kullanıcı onayı) çağrılır, taslak adımı asla kaydetmez.
 */
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 4000;

export interface AgentDraft { name: string; role: string; systemPrompt: string; tools: string[] }
export interface DraftResult { draft: AgentDraft; droppedTools: string[]; provider: string | null; model: string | null }
export interface CreatedAgent { id: string | null; name: string; role: string; tools: string[]; droppedTools: string[] }

export type AgentFailure = "session" | "payment" | "forbidden" | "notFound" | "rateLimit" | "timeout" | "network" | "noProvider" | "badDraft" | "badResponse" | "generic";

export type ComposerState =
  | { phase: "idle" }
  | { phase: "drafting"; description: string }
  | { phase: "draft"; description: string; result: DraftResult }
  | { phase: "confirming"; description: string; result: DraftResult }
  | { phase: "created"; created: CreatedAgent }
  | { phase: "error"; stage: "draft" | "confirm"; description: string; kind: AgentFailure; result?: DraftResult };

export function descriptionProblem(text: string): "tooShort" | "tooLong" | null {
  const n = text.trim().length;
  if (n < DESCRIPTION_MIN) return "tooShort";
  if (n > DESCRIPTION_MAX) return "tooLong";
  return null;
}

const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Sunucu yanıtını savunmalı okur; bozuk şekil `null` (uydurma alan yok). */
export function parseDraftResponse(raw: unknown): DraftResult | null {
  if (!isObj(raw) || !isObj(raw.draft)) return null;
  const d = raw.draft;
  const tools = strList(d.tools);
  const dropped = raw.droppedTools === undefined ? [] : strList(raw.droppedTools);
  if (typeof d.name !== "string" || !d.name || typeof d.role !== "string" || !d.role || typeof d.systemPrompt !== "string" || !tools || !dropped) return null;
  return { draft: { name: d.name, role: d.role, systemPrompt: d.systemPrompt, tools }, droppedTools: dropped, provider: optStr(raw.provider), model: optStr(raw.model) };
}

export function parseConfirmResponse(raw: unknown): CreatedAgent | null {
  if (!isObj(raw) || !isObj(raw.agent)) return null;
  const a = raw.agent;
  const tools = strList(a.tools) ?? [];
  const dropped = raw.droppedTools === undefined ? [] : strList(raw.droppedTools);
  if (typeof a.name !== "string" || !a.name || typeof a.role !== "string" || !dropped) return null;
  return { id: typeof a.id === "string" ? a.id : null, name: a.name, role: a.role, tools, droppedTools: dropped };
}

/** 402 ve 400-türleri dahil açık sınıflar; sağlayıcı/sunucu ham metni arayüze verilmez. */
export function classifyAgentFailure(error: unknown): AgentFailure {
  if (!error || typeof error !== "object") return "generic";
  const r = error as { status?: unknown; name?: unknown; code?: unknown; message?: unknown };
  const message = typeof r.message === "string" ? r.message : "";
  if (r.status === 401 || r.name === "SessionChangedError") return "session";
  if (r.status === 402) return "payment";
  if (r.status === 403) return "forbidden";
  if (r.status === 404) return "notFound";
  if (r.status === 429) return "rateLimit";
  if (r.status === 408 || r.status === 504 || r.name === "TimeoutError" || r.code === "REQUEST_TIMEOUT") return "timeout";
  if (r.status === 400) return /ai provider|api key|configure/i.test(message) ? "noProvider" : "badDraft";
  if (r.name === "TypeError" && /failed to fetch|fetch failed|networkerror|load failed/i.test(message)) return "network";
  return "generic";
}

/** Bağlantı kopması/zaman aşımında confirm sonucu belirsizdir: ajan kaydedilmiş olabilir. */
export const mayBeSaved = (kind: AgentFailure) => kind === "network" || kind === "timeout";

export interface ComposeDeps {
  draft: (description: string) => Promise<unknown>;
  confirm: (draft: AgentDraft) => Promise<unknown>;
}

/** 1. adım: taslak. Kayıt YAZMAZ (yalnız `deps.draft` çağrılır). */
export async function requestDraft(deps: ComposeDeps, description: string): Promise<ComposerState> {
  const text = description.trim();
  if (descriptionProblem(text)) return { phase: "idle" };
  try {
    const result = parseDraftResponse(await deps.draft(text));
    return result ? { phase: "draft", description: text, result } : { phase: "error", stage: "draft", description: text, kind: "badResponse" };
  } catch (e) {
    return { phase: "error", stage: "draft", description: text, kind: classifyAgentFailure(e) };
  }
}

/** 2. adım: yalnız kullanıcı onayıyla ve yalnız taslak durumundan. Hata halinde taslak korunur (yeniden denenebilir). */
export async function confirmDraft(deps: ComposeDeps, state: ComposerState): Promise<ComposerState> {
  const result = state.phase === "draft" ? state.result : state.phase === "error" && state.stage === "confirm" ? state.result : undefined;
  if (!result) return state;
  const description = "description" in state ? state.description : "";
  try {
    const created = parseConfirmResponse(await deps.confirm(result.draft));
    return created ? { phase: "created", created } : { phase: "error", stage: "confirm", description, kind: "badResponse", result };
  } catch (e) {
    return { phase: "error", stage: "confirm", description, kind: classifyAgentFailure(e), result };
  }
}

export interface AgentRow { id: string; name: string; role: string; tools: string[]; status: string | null; autonomy: string | null }

/** Liste satırı: yalnız API'nin verdiği alanlar. `status` API'de yoksa null ("bilinmiyor" yazılır; durum uydurulmaz). */
export function toAgentRows(raw: unknown): AgentRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Record<string, unknown> => isObj(a) && typeof a.id === "string").map((a) => ({
    id: a.id as string,
    name: typeof a.name === "string" && a.name ? a.name : (a.id as string),
    role: typeof a.role === "string" ? a.role : "",
    tools: strList(a.tools) ?? [],
    status: optStr(a.status),
    autonomy: optStr(a.autonomy),
  }));
}
