/**
 * BRA-P0-03c — plan kartı akışı: SAF durum geçişleri (DOM'suz test edilir). Sessiz yutma yok:
 * her hata `error` durumuna ve görünür bir türe düşer.
 */
import { classifyFailure, type FailureKind } from "./localized-error";
import type { PlanCardView, PlanResponse, StartResponse } from "./planCardParse";

export type StartErrorKind =
  | FailureKind | "approvalGate" | "planChanged" | "workspaceRequired" | "keyConflict" | "companyInactive" | "noAgent" | "validation";

/** Başlatma bu durumlarda kalıcı olarak engelli: Çalıştır devre dışı (yeniden denemek anlamsız). */
export const START_BLOCKED: readonly StartErrorKind[] = ["companyInactive", "noAgent", "approvalGate"];

export type PlanState =
  | { phase: "idle" }
  | { phase: "planning"; message: string }
  | { phase: "empty"; message: string }
  | { phase: "planError"; message: string; kind: FailureKind }
  | { phase: "ready" | "starting" | "startError"; message: string; card: PlanCardView; planHash: string; idempotencyKey: string; workspaceId?: string; error?: StartErrorKind }
  | { phase: "started"; runId: string };

export interface PlanDeps {
  plan: (message: string, workspaceId?: string) => Promise<PlanResponse>;
  start: (body: { message: string; workspaceId?: string; planHash: string; idempotencyKey: string }) => Promise<StartResponse>;
  newKey: () => string;
}

/** Onay adımlı / yüksek riskli kart: STEP_APPROVAL_GATE kapalıyken API 422 döner. */
export function cardNeedsApproval(card: PlanCardView): boolean {
  return card.risk === "high" || card.steps.some((s) => s.needsApproval);
}

export const needsWorkspaceChoice = (companyCount: number): boolean => companyCount > 1;

export async function submitPlan(deps: PlanDeps, rawMessage: string, workspaceId: string | undefined): Promise<PlanState> {
  const message = rawMessage.trim();
  if (!message) return { phase: "idle" };
  try {
    const res = await deps.plan(message, workspaceId);
    if (res.intent === "chat") return { phase: "empty", message };
    return { phase: "ready", message, card: res.card, planHash: res.planHash, idempotencyKey: deps.newKey(), workspaceId };
  } catch (error) {
    return { phase: "planError", message, kind: classifyFailure(error) };
  }
}

/** Gövdedeki `error` alanı (ApiRequestError.serverError) ayrımı belirler; HTTP durumu tek başına yetmez. */
export function startErrorKind(error: unknown, card: PlanCardView): StartErrorKind {
  const e = error as { status?: unknown; serverError?: unknown; message?: unknown } | null;
  const status = e?.status;
  const code = typeof e?.serverError === "string" ? e.serverError : typeof e?.message === "string" ? e.message : "";
  if (status === 422) {
    if (code === "high_risk_start_unsupported") return "approvalGate";
    if (/no agent/i.test(code)) return "noAgent";
    return cardNeedsApproval(card) && code === "" ? "approvalGate" : "validation";
  }
  if (status === 409) {
    if (code === "plan_changed") return "planChanged";
    if (/idempotency key/i.test(code)) return "keyConflict";
    if (/paused or archived/i.test(code)) return "companyInactive";
    return "generic";
  }
  if (status === 400) return /workspaceId is required/i.test(code) ? "workspaceRequired" : "validation";
  return classifyFailure(error);
}

/** `ready`/`startError` dışında çalışmaz (çift tıklama kilidi: `starting` durumu yeni başlatmayı yok sayar). */
export async function submitStart(deps: PlanDeps, state: PlanState, workspaceId: string | undefined, companyCount: number): Promise<PlanState> {
  if (state.phase !== "ready" && state.phase !== "startError") return state;
  if (state.phase === "startError" && state.error && START_BLOCKED.includes(state.error)) return state;
  if (needsWorkspaceChoice(companyCount) && !workspaceId) return { ...state, phase: "startError", error: "workspaceRequired" };
  try {
    const res = await deps.start({ message: state.message, workspaceId, planHash: state.planHash, idempotencyKey: state.idempotencyKey });
    return { phase: "started", runId: res.runId };
  } catch (error) {
    return { ...state, phase: "startError", error: startErrorKind(error, state.card) };
  }
}

/** Sayfa düzeyi yarış koruması: alan değişimi/vazgeç/yeni istek eski yanıtı geçersiz kılar. */
export function makeGuard() {
  let n = 0;
  return { next: () => ++n, invalidate: () => { n++; }, isCurrent: (id: number) => id === n };
}

/** Tek şirkette (ya da seçimsiz) workspaceId gönderilmez; çoklu şirkette seçilen gönderilir. */
export const workspaceForRequest = (multi: boolean, chosen: string): string | undefined => (multi ? chosen || undefined : undefined);
