"use client";
/**
 * BRA-UX-05a — plan kartı paneli (04-design.md §5.2). Kart içeriği YALNIZ React metin düğümü olarak çizilir
 * (`dangerouslySetInnerHTML` yok). Veri `POST /jobs/plan` kartıdır; "Çalıştır" `POST /jobs/start` çağırır.
 * Adım başına model satırı bu sürümde YOK (API ister): uydurulmaz, açıkça yazılır.
 */
import { START_BLOCKED, type StartErrorKind } from "../../lib/planFlow";
import type { PlanCardView } from "../../lib/planCardParse";
import { costRangeText, startErrorText, type T } from "../plan/PlanParts";
import { btn, btnPrimary, glass, muted } from "./styles";

export function PlanPanel({ card, t, locale, busy, startError, onStart, onCancel, onReplan }: {
  card: PlanCardView; t: T; locale: string; busy: boolean; startError?: StartErrorKind | null;
  onStart: () => void; onCancel: () => void; onReplan: () => void;
}) {
  const blocked = !!startError && START_BLOCKED.includes(startError);
  const cost = costRangeText(card.estimate, locale);
  return (
    <article style={{ ...glass, display: "grid", gap: 10 }} aria-label={card.title} data-testid="intent-plan-card" data-risk={card.risk}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{card.title}</h2>
      <p style={{ margin: 0 }}>{card.goal}</p>
      <ol style={{ margin: 0, paddingInlineStart: 20, display: "grid", gap: 4 }}>
        {card.steps.map((s, i) => (
          <li key={i}>
            {s.title}
            {s.tool ? <span style={muted}> · {t("app.intent.plan.tool", { tool: s.tool })}</span> : null}
            {s.needsApproval ? <strong> · ⚠ {t("app.intent.plan.approvalStep", { risk: t(`app.plan.risk.${s.risk}`).toLocaleLowerCase(locale) })}</strong> : null}
          </li>
        ))}
      </ol>
      <div>
        <strong>{t("app.plan.risk.label")}:</strong> {t(`app.plan.risk.${card.risk}`)} · <strong>{t("app.plan.cost")}:</strong> {cost ?? t("app.plan.costUnknown")}
      </div>
      <div style={muted}>{t("app.intent.plan.modelRow")}</div>
      {startError && <div role="alert" style={{ color: "var(--color-error)", fontWeight: 600 }}>{startErrorText(t, startError)}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={{ ...btnPrimary, opacity: busy || blocked ? 0.6 : 1 }} disabled={busy || blocked} aria-busy={busy} onClick={onStart}>
          {busy ? t("app.plan.starting") : `${t("app.plan.run")} ▸`}
        </button>
        {startError === "planChanged" && <button type="button" style={btn} onClick={onReplan}>{t("app.plan.replan")}</button>}
        <button type="button" style={btn} disabled={busy} onClick={onCancel}>{t("app.plan.cancel")}</button>
      </div>
    </article>
  );
}
