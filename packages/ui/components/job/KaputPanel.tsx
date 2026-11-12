"use client";
/**
 * BRA-UX-05d — Kaputu Aç: ham listeden okunur teknik görünüme.
 * Yalnız `parseKaput`'un çıkardığı alanlar gösterilir (ham input/output/payload/yol/token/kimlik YOK); serbest metinler
 * maskelenir (`maskKaputText`), sonra kırpılır, düz metin olarak, `overflow-wrap:anywhere`. Sade: kompakt satırlar; Tam: adım kartları.
 */
import { useId } from "react";
import type { Kaput, KaputStep, KaputToolCall } from "../../lib/ux-lab/facts";
import { clipText, safeText } from "../../lib/ux-kaput/mask";
import { money, type T } from "../inbox/InboxParts";

export type KaputLoad = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; kaput: Kaput };

export const RUN_ERROR_MAX = 500;
export const REASONING_MAX = 600;
export const NAME_MAX = 120;
const STEP_ERROR_MAX = 300;
const RAW_STATUS_MAX = 40;

const KNOWN = ["completed", "running", "failed", "pending", "skipped", "cancelled"] as const;
type KnownStatus = (typeof KNOWN)[number];
/** Ham durum → bilinen anahtar (yoksa null = "unknown" etiketi). */
export function statusKey(raw: string): KnownStatus | null {
  const s = raw.toLowerCase() === "canceled" ? "cancelled" : raw.toLowerCase();
  return (KNOWN as readonly string[]).includes(s) ? (s as KnownStatus) : null;
}
export { clipText as clip };

/** Süre biçimi için saf yardımcı: negatif/sonlu olmayan → null; yuvarlama sonrası eşik (999,6 ms → 1,0 sn). */
export function durationParts(ms: number | null): { unit: "ms" | "s"; value: number } | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const rounded = Math.round(ms);
  return rounded < 1000 ? { unit: "ms", value: rounded } : { unit: "s", value: ms / 1000 };
}

const btn: React.CSSProperties = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
};
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const wrap: React.CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 };
const mono: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };
const errStyle: React.CSSProperties = { ...muted, color: "var(--color-error)", ...wrap };
const badgeStyle = (failed: boolean): React.CSSProperties => ({
  display: "inline-block", paddingInline: 8, paddingBlock: 2, borderRadius: 999, fontSize: 12, fontWeight: 700,
  border: `1px solid ${failed ? "var(--color-error)" : "var(--color-surface-container-highest)"}`,
  color: failed ? "var(--color-error)" : "var(--color-on-surface-variant)", background: "var(--color-surface-container)",
});

export default function KaputPanel({ load, full, t, locale, onRetry }: { load: KaputLoad; full: boolean; t: T; locale: string; onRetry: () => void }) {
  const uid = useId();
  if (load.status === "loading" || load.status === "idle") return <div role="status" aria-busy="true" style={muted}>{t("app.jobs.kaput.loading")}</div>;
  if (load.status === "error") {
    return (
      <div role="alert" style={{ ...muted, color: "var(--color-error)" }}>
        {t("app.jobs.kaput.error")} <button type="button" style={btn} onClick={onRetry}>{t("app.inbox.retryLoad")}</button>
      </div>
    );
  }
  const k = load.kaput;
  const unknown = t("app.jobs.kaput.unknown");
  const num = (n: number, o?: Intl.NumberFormatOptions) => { try { return new Intl.NumberFormat(locale, o).format(n); } catch { return String(n); } };
  const percent = (r: number) => num(r, { style: "percent", maximumFractionDigits: 0 });
  const duration = (ms: number | null): string => {
    const p = durationParts(ms);
    if (!p) return unknown;
    return p.unit === "ms" ? t("app.jobs.kaput.millis", { value: num(p.value) }) : t("app.jobs.kaput.seconds", { value: num(p.value, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
  };
  const status = (raw: string) => {
    const key = statusKey(raw);
    return key ? t(`app.jobs.kaput.stepStatus.${key}`) : full ? `${t("app.jobs.kaput.stepStatus.unknown")} (${safeText(raw, RAW_STATUS_MAX)})` : t("app.jobs.kaput.stepStatus.unknown");
  };
  const steps = [...k.steps].sort((a, b) => a.index - b.index);
  const total = k.totalCostUsd;
  const budget = k.budgetUsd ?? null;
  const ratio = budget !== null && total !== null ? total / budget : null;
  const runError = k.runError ? safeText(k.runError, RUN_ERROR_MAX) : null;

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }} data-testid="job-kaput">
      {runError && (
        <div role="status" data-testid="job-kaput-error" style={{ padding: 12, borderRadius: 10, border: "1px solid var(--color-error)", background: "var(--color-surface-container)", display: "grid", gap: 6, ...wrap }}>
          <strong style={{ color: "var(--color-error)" }}>{t("app.jobs.kaput.runErrorTitle")}</strong>
          <span>{t("app.jobs.kaput.runErrorPlain")}</span>
          {full && <pre dir="ltr" style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, ...mono, color: "var(--color-on-surface-variant)", ...wrap }} data-testid="job-kaput-error-raw">{runError}</pre>}
        </div>
      )}
      <div style={wrap}>{t("app.jobs.kaput.summary", {
        steps: k.steps.length, tools: k.toolCallCount, cost: total === null ? "—" : (money(total, locale) ?? "—"), handoffs: k.handoffCount === null ? unknown : k.handoffCount,
      })}</div>
      {budget !== null && total !== null && ratio !== null && (
        <div style={muted} data-testid="job-kaput-budget">
          {t("app.jobs.kaput.budget", { cost: money(total, locale) ?? "—", budget: money(budget, locale) ?? "—", percent: percent(ratio) })}
          {ratio > 1 && <strong data-testid="job-kaput-over" style={{ color: "var(--color-error)" }}> · {t("app.jobs.kaput.overBudget")}</strong>}
        </div>
      )}
      {steps.length === 0 ? <span style={muted}>{t("app.jobs.kaput.noSteps")}</span> : full ? (
        <div style={{ display: "grid", gap: 10 }}>
          {steps.map((s, i) => <FullStep key={s.id} s={s} n={i + 1} hid={`${uid}-s${i}`} t={t} locale={locale} total={total} percent={percent} duration={duration} status={status} />)}
        </div>
      ) : (
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {steps.map((s, i) => {
            const failed = statusKey(s.status) === "failed";
            const errs = [s.error ?? null, ...s.toolCalls.map((c) => c.error)].filter((e): e is string => !!e);
            return (
              <li key={s.id} style={{ display: "grid", gap: 2, ...wrap }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={muted}>{i + 1}.</span><span dir="auto" style={wrap}>{safeText(s.name, NAME_MAX)}</span>
                  <span style={badgeStyle(failed)}>{status(s.status)}</span>
                  {s.toolCalls.length > 0 && <span style={muted}>· {s.toolCalls.length}</span>}
                </div>
                {errs.map((e, j) => <span key={j} dir="auto" style={errStyle}>{t("app.jobs.kaput.errorLabel")}: {safeText(e, STEP_ERROR_MAX)}</span>)}
              </li>
            );
          })}
        </ol>
      )}
      <p style={{ ...muted, margin: 0 }}>{t("app.jobs.kaput.later")}</p>
    </div>
  );
}

function FullStep({ s, n, hid, t, locale, total, percent, duration, status }: {
  s: KaputStep; n: number; hid: string; t: T; locale: string; total: number | null;
  percent: (r: number) => string; duration: (ms: number | null) => string; status: (raw: string) => string;
}) {
  const failed = statusKey(s.status) === "failed";
  const unknown = t("app.jobs.kaput.unknown");
  const share = s.costUsd !== null && total !== null && total > 0 ? percent(s.costUsd / total) : null;
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", ...wrap }}><span style={muted}>{label}:</span><span dir="auto" style={wrap}>{value}</span></div>
  );
  return (
    <section aria-labelledby={hid} data-testid="job-kaput-step" style={{ padding: 12, borderRadius: 10, display: "grid", gap: 6, background: "var(--color-surface-container)", border: `1px solid ${failed ? "var(--color-error)" : "var(--color-surface-container-highest)"}`, ...wrap }}>
      <h4 id={hid} style={{ margin: 0, fontSize: 15, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={muted}>{n}.</span><span dir="auto" style={wrap}>{safeText(s.name, NAME_MAX)}</span><span style={badgeStyle(failed)}>{status(s.status)}</span>
      </h4>
      {row(t("app.jobs.kaput.agent"), s.agentRole ? safeText(s.agentRole, NAME_MAX) : unknown)}
      {row(t("app.jobs.kaput.duration"), duration(s.durationMs))}
      {row(t("app.jobs.kaput.stepCost"), s.costUsd !== null ? `${money(s.costUsd, locale) ?? unknown}${share ? ` · ${t("app.jobs.kaput.share", { percent: share })}` : ""}` : unknown)}
      {s.error && row(t("app.jobs.kaput.errorLabel"), <span style={{ color: "var(--color-error)" }}>{safeText(s.error, STEP_ERROR_MAX)}</span>)}
      {s.reasoning && row(t("app.jobs.kaput.reasoning"), safeText(s.reasoning, REASONING_MAX))}
      <div style={muted}>{t("app.jobs.kaput.tools")}</div>
      {s.toolCalls.length === 0 ? <span style={muted}>{t("app.jobs.kaput.noTools")}</span> : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {s.toolCalls.map((c) => <ToolRow key={c.id} c={c} t={t} duration={duration} status={status} />)}
        </ul>
      )}
    </section>
  );
}

function ToolRow({ c, t, duration, status }: { c: KaputToolCall; t: T; duration: (ms: number | null) => string; status: (raw: string) => string }) {
  // Hata taşıyan çağrı "tamamlandı" görünmez (status eksik → varsayılan completed çelişkisi).
  const failed = statusKey(c.status) === "failed" || !!c.error;
  const dur = durationParts(c.durationMs) ? duration(c.durationMs) : null;
  return (
    <li style={{ display: "grid", gap: 2, ...wrap }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span dir="ltr" style={{ ...mono, fontSize: 13, ...wrap }}>{safeText(c.toolName, NAME_MAX)}</span>
        <span style={badgeStyle(failed)}>{c.error && statusKey(c.status) !== "failed" ? t("app.jobs.kaput.stepStatus.failed") : status(c.status)}</span>
        {dur && <span style={muted}>{dur}</span>}
      </div>
      {c.error && <span dir="auto" style={errStyle}>{t("app.jobs.kaput.errorLabel")}: {safeText(c.error, STEP_ERROR_MAX)}</span>}
    </li>
  );
}
