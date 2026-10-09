/** Secret-free discovery contract. No client-side capability guesses. */
export type ReasoningEffort = "low" | "medium" | "high";
export interface CompareSelection { provider: string; model: string; reasoningEffort?: ReasoningEffort }
export interface CompareOption { provider: string; model: string; reasoningEfforts: ReasoningEffort[] }
export interface CompareOptions { companyId: string; maxCandidates: 3; selections: CompareOption[] }
export interface CompareRequest { companyId: string; query: string; selections: CompareSelection[] }
export interface CompareResult {
  perModel: { provider: string; model: string; answer: string; reasoningEffort?: ReasoningEffort }[];
  failed: { provider: string; model: string; error: string }[];
  finalAnswer: string;
  synthesisStatus: string;
  synthesizer: { provider?: string; model?: string } | null;
  synthesizerError?: string;
}
export interface CompareSession {
  id: string; companyId: string; status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  findings?: { multiModel?: CompareResult } | null;
}
export const selectionKey = (selection: {provider: string; model: string}) => JSON.stringify([selection.provider, selection.model]);
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
}
export function parseCompareOptions(value: unknown, companyId: string): CompareOptions {
  if (!object(value) || !exactKeys(value, ["companyId", "maxCandidates", "selections"])
    || value.companyId !== companyId || value.maxCandidates !== 3 || !Array.isArray(value.selections)) {
    throw new Error("Invalid compare options response");
  }
  const seen = new Set<string>();
  for (const row of value.selections) {
    if (!object(row) || !exactKeys(row, ["provider", "model", "reasoningEfforts"])
      || typeof row.provider !== "string" || !row.provider || typeof row.model !== "string" || !row.model
      || !Array.isArray(row.reasoningEfforts) || !row.reasoningEfforts.every(isReasoningEffort)
      || new Set(row.reasoningEfforts).size !== row.reasoningEfforts.length) throw new Error("Invalid compare selection option");
    const key = selectionKey(row as unknown as CompareOption);
    if (seen.has(key)) throw new Error("Ambiguous compare selection option");
    seen.add(key);
  }
  return value as unknown as CompareOptions;
}
export function validCompareSelections(options: CompareOptions | undefined, selections: CompareSelection[]): boolean {
  if (!options || selections.length < 1 || selections.length > options.maxCandidates) return false;
  const seen = new Set<string>();
  return selections.every(selection => {
    const key = selectionKey(selection);
    if (seen.has(key)) return false;
    seen.add(key);
    const option = options.selections.find(row => selectionKey(row) === key);
    return !!option && (selection.reasoningEffort === undefined || option.reasoningEfforts.includes(selection.reasoningEffort));
  });
}
export function parseCompareSession(value: unknown, id: string, companyId: string): CompareSession {
  if (!object(value) || value.id !== id || value.companyId !== companyId
    || !["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(String(value.status))) throw new Error("Invalid compare session response");
  if (value.status === "COMPLETED") {
    const findings = value.findings;
    const result = object(findings) ? findings.multiModel : undefined;
    if (!object(result) || typeof result.finalAnswer !== "string" || typeof result.synthesisStatus !== "string"
      || !Array.isArray(result.perModel) || !Array.isArray(result.failed)
      || !result.perModel.every(row => object(row) && typeof row.provider === "string" && typeof row.model === "string" && typeof row.answer === "string"
        && (row.reasoningEffort === undefined || isReasoningEffort(row.reasoningEffort)))
      || !result.failed.every(row => object(row) && typeof row.provider === "string" && typeof row.model === "string" && typeof row.error === "string")
      || !(result.synthesizer === null || (object(result.synthesizer)
        && (result.synthesizer.provider === undefined || typeof result.synthesizer.provider === "string")
        && (result.synthesizer.model === undefined || typeof result.synthesizer.model === "string")))
      || (result.synthesizerError !== undefined && typeof result.synthesizerError !== "string")) throw new Error("Invalid compare result response");
  }
  return value as unknown as CompareSession;
}
