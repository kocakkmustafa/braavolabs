"use client";
/**
 * BRA-UX-05a — ajan isteği (04-design.md §5.5, E9). `POST /companies/:id/agents/compose` ajanı HEMEN kaydeder: taslak ucu
 * YOK (ayrı bilet: BRA-UX-API-03). Tasarımdaki "Taslak → Oluştur" iki adımı bu yüzden yapılamaz; arayüz TEK adımı açıkça
 * söyler ve Enter'a ya da çubuğa basmak ajanı kaydetmez: kayıt yalnız bu kartın "Ajanı hemen oluştur" düğmesiyle olur.
 */
import type { FailureKind } from "../../lib/localized-error";
import type { T } from "../plan/PlanParts";
import { btn, btnPrimary, glass, muted } from "./styles";

export interface AgentResult { name: string; role: string; tools: string[]; droppedTools: string[] }
export type AgentState =
  | { phase: "idle" }
  | { phase: "confirm"; description: string; error?: "workspaceRequired" }
  | { phase: "working"; description: string }
  | { phase: "done"; description: string; result: AgentResult }
  | { phase: "error"; description: string; kind: FailureKind };

export function AgentPanel({ state, t, onCreate, onCancel }: { state: AgentState; t: T; onCreate: () => void; onCancel: () => void }) {
  if (state.phase === "idle") return null;
  if (state.phase === "working") return <div role="status" aria-busy="true" style={glass}>{t("app.intent.agent.working")}</div>;
  if (state.phase === "error") {
    return (
      <div role="alert" style={{ ...glass, display: "grid", gap: 8, borderColor: "var(--color-error)" }}>
        <span>{t(`surface.error.${state.kind}`)}</span>
        <div><button type="button" style={btn} onClick={onCreate}>{t("app.plan.retry")}</button></div>
      </div>
    );
  }
  if (state.phase === "confirm") {
    return (
      <article style={{ ...glass, display: "grid", gap: 10 }} aria-label={t("app.intent.agent.title")} data-testid="intent-agent-confirm">
        <h2 style={{ margin: 0, fontSize: 18 }}>{t("app.intent.agent.title")}</h2>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{state.description}</p>
        <div role="note" style={{ ...muted, color: "var(--color-on-surface)" }}>{t("app.intent.agent.immediate")}</div>
        {state.error && <div role="alert" style={{ color: "var(--color-error)", fontWeight: 600 }}>{t("app.plan.workspaceRequired")}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={btnPrimary} onClick={onCreate}>{t("app.intent.agent.create")}</button>
          <button type="button" style={btn} onClick={onCancel}>{t("app.plan.cancel")}</button>
        </div>
      </article>
    );
  }
  const { result } = state;
  return (
    <article style={{ ...glass, display: "grid", gap: 8 }} aria-label={result.name} data-testid="intent-agent-done">
      <h2 style={{ margin: 0, fontSize: 18 }}>{result.name} <span style={muted}>· {t("app.intent.agent.role", { role: result.role })}</span></h2>
      <div><strong>{t("app.intent.agent.toolsLabel")}:</strong> {result.tools.length ? result.tools.join(", ") : t("app.intent.agent.noTools")}</div>
      {result.droppedTools.length > 0 && (
        <div role="alert" style={{ ...glass, borderColor: "var(--color-error)" }} data-testid="intent-agent-dropped">
          {t("app.intent.agent.dropped", { count: result.droppedTools.length, tools: result.droppedTools.join(", ") })}
        </div>
      )}
      <div style={muted}>{t("app.intent.agent.saved")}</div>
      <div><button type="button" style={btn} onClick={onCancel}>{t("app.intent.agent.close")}</button></div>
    </article>
  );
}
