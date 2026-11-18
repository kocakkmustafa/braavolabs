"use client";
/**
 * BRA-P0-03c — plan kartı görünümü. Kart içeriği YALNIZ React metin düğümü olarak çizilir:
 * `dangerouslySetInnerHTML` yok, markdown yok, autolink yok (sahte bağlantı/XSS önlemi).
 */
import type { PlanCardView } from "../../lib/planCardParse";
import { START_BLOCKED, type StartErrorKind } from "../../lib/planFlow";

export type T = (key: string, values?: Record<string, string | number>) => string;

const card: React.CSSProperties = { background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)", borderRadius: 14, padding: 16, display: "grid", gap: 10 };
const btn: React.CSSProperties = { minHeight: 44, padding: "8px 16px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" };
const btnPrimary: React.CSSProperties = { ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

/** Fiyatı bilinmiyorsa null: "ücretsiz" gibi okunmaz. */
export function costRangeText(c: PlanCardView["estimate"], locale: string): string | null {
  const { low, high } = c.costUsd;
  if (!c.priced || low === null || high === null) return null;
  let fmt: (n: number) => string;
  try {
    const nf = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
    fmt = (n) => nf.format(n);
  } catch { fmt = (n) => `$${n}`; }
  return low === high ? fmt(low) : `${fmt(low)} – ${fmt(high)}`;
}

export function PlanSkeleton({ t }: { t: T }) {
  return <div role="status" aria-busy="true" style={{ ...card, opacity: 0.7 }}>{t("app.plan.planning")}</div>;
}

export function PlanMessageBox({ t, kind, body, onRetry }: { t: T; kind: "alert" | "status"; body: string; onRetry?: () => void }) {
  return (
    <div role={kind === "alert" ? "alert" : "status"} style={card}>
      <span>{body}</span>
      {onRetry && <div><button type="button" style={btn} onClick={onRetry}>{t("app.plan.retry")}</button></div>}
    </div>
  );
}

export function startErrorText(t: T, kind: StartErrorKind): string {
  return ["approvalGate","planChanged","workspaceRequired","keyConflict","companyInactive","noAgent","validation"].includes(kind) ? t(`app.plan.${kind}`) : t(`surface.error.${kind}`);
}

export function PlanCardPanel({ card: c, t, locale, busy, startError, onStart, onCancel, onReplan }: {
  card: PlanCardView; t: T; locale: string; busy: boolean; startError?: StartErrorKind | null;
  onStart: () => void; onCancel: () => void; onReplan?: () => void;
}) {
  const blocked = !!startError && START_BLOCKED.includes(startError);
  const tools = Array.from(new Set(c.steps.map((s) => s.tool).filter((x): x is string => !!x)));
  const cost = costRangeText(c.estimate, locale);
  return (
    <article style={card} aria-label={c.title}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{c.title}</h2>
      <p style={{ margin: 0 }}>{c.goal}</p>
      <div>
        <strong>{t("app.plan.steps")}</strong>
        <ol style={{ margin: "4px 0 0", paddingInlineStart: 20 }}>
          {c.steps.map((s, i) => (
            <li key={i}>{s.title}{s.needsApproval ? ` · ${t("app.plan.approvalStep")}` : ""}</li>
          ))}
        </ol>
      </div>
      {tools.length > 0 && <div><strong>{t("app.plan.tools")}:</strong> <span>{tools.join(", ")}</span></div>}
      <div><strong>{t("app.plan.risk.label")}:</strong> <span data-risk={c.risk}>{t(`app.plan.risk.${c.risk}`)}</span></div>
      <div style={muted}><strong>{t("app.plan.cost")}:</strong> <span>{cost ?? t("app.plan.costUnknown")}</span></div>
      {startError && <div role="alert" style={{ color: "var(--color-error)", fontWeight: 600 }}>{startErrorText(t, startError)}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={btnPrimary} disabled={busy || blocked} aria-busy={busy} onClick={onStart}>{busy ? t("app.plan.starting") : t("app.plan.run")}</button>
        {startError === "planChanged" && onReplan && <button type="button" style={btn} disabled={busy} onClick={onReplan}>{t("app.plan.replan")}</button>}
        <button type="button" style={btn} disabled={busy} onClick={onCancel}>{t("app.plan.cancel")}</button>
      </div>
    </article>
  );
}
