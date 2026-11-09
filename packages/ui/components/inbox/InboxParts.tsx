"use client";
import Link from "next/link";
import { useState } from "react";
import type { InboxBucket, JobReceipt } from "@ai-company-os/core";
import {
  allowedActions, nextTabIndex, receiptVerified,
  type InboxApproval, type InboxApprovalGroup, type InboxRun, type RunAction,
} from "../../lib/inbox";

export type T = (key: string, values?: Record<string, string | number>) => string;

const card: React.CSSProperties = {
  background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)",
  borderRadius: 14, padding: 16,
};
const btn: React.CSSProperties = {
  minHeight: 36, padding: "6px 12px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
  border: "1px solid var(--color-surface-container-highest)",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

export function money(v: number | string | null | undefined, locale: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}
function when(v: string | null | undefined, locale: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  try { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d); } catch { return null; }
}

export function BucketTabs({ tabs, active, onChange, t, rtl = false }: {
  tabs: readonly InboxBucket[]; active: InboxBucket; onChange: (b: InboxBucket) => void; t: T; rtl?: boolean;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = nextTabIndex(e.key, tabs.indexOf(active), tabs.length, rtl);
    if (i === null) return;
    e.preventDefault();
    onChange(tabs[i]);
    requestAnimationFrame(() => document.getElementById(`inbox-tab-${tabs[i]}`)?.focus());
  };
  return (
    <div role="tablist" aria-label={t("app.inbox.tabsLabel")} onKeyDown={onKeyDown}
      style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
      {tabs.map((b) => {
        const on = b === active;
        return (
          <button key={b} id={`inbox-tab-${b}`} role="tab" type="button" aria-selected={on}
            aria-controls="inbox-panel" tabIndex={on ? 0 : -1} onClick={() => onChange(b)}
            style={{
              ...btn, whiteSpace: "nowrap", minHeight: 40,
              background: on ? "var(--color-primary)" : "var(--color-surface-container)",
              color: on ? "var(--color-on-primary)" : "var(--color-on-surface)",
            }}>
            {t(`app.inbox.bucket.${b}`)}
          </button>
        );
      })}
    </div>
  );
}

export function ErrorBox({ title, body, onRetry, t }: { title: string; body: string; onRetry: () => void; t: T }) {
  return (
    <div role="alert" style={{ ...card, borderColor: "var(--color-error)", display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px" }}>
        <p style={{ fontWeight: 700, color: "var(--color-on-surface)" }}>{title}</p>
        <p style={muted}>{body}</p>
      </div>
      <button type="button" style={btnPrimary} onClick={onRetry}>{t("app.inbox.retryLoad")}</button>
    </div>
  );
}

export function EmptyBox({ text }: { text: string }) {
  return <div style={{ ...card, textAlign: "center", padding: 32 }}><p style={muted}>{text}</p></div>;
}

export function ArtifactView({ artifact, t }: { artifact: NonNullable<InboxApproval["artifact"]>; t: T }) {
  // Düz metin: React metin düğümü olarak basar (HTML yorumlanmaz, otomatik bağlantı yok).
  return (
    <div style={{ margin: "10px 0", borderRadius: 10, border: "1px solid var(--color-surface-container-highest)", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "var(--color-surface-container-low)", fontSize: 12 }}>
        <strong style={{ color: "var(--color-primary)" }}>{t(`app.approvals.artifactKind.${artifact.kind}`)}</strong>
        <span style={{ marginInlineStart: "auto", color: "var(--color-on-surface-variant)" }}>{t("app.approvals.artifactAiLabel")}</span>
      </div>
      {artifact.title && <div style={{ padding: "10px 12px 0", fontWeight: 600, color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{artifact.title}</div>}
      <pre tabIndex={0} aria-label={t("app.inbox.artifactLabel")} style={{ margin: 0, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflowY: "auto", color: "var(--color-on-surface-variant)" }}>{artifact.body}</pre>
    </div>
  );
}

function ApprovalCard({ a, busy, error, onDecide, t, locale }: {
  a: InboxApproval; busy: boolean; error?: string;
  onDecide: (a: InboxApproval, d: "APPROVED" | "REJECTED", note?: string) => void; t: T; locale: string;
}) {
  const [note, setNote] = useState("");
  const amount = money(a.amountUsd, locale);
  // INPUT (ask_user): onay = ajana yanıt; not yanıt olarak gider (API decideSchema.note) → not zorunlu.
  const isInput = a.type === "INPUT";
  const expires = when(a.expiresAt, locale);
  return (
    <li style={{ borderTop: "1px solid var(--color-surface-container-high)", paddingTop: 10 }}>
      <p style={{ color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>
        {a.description || a.metadata?.toolName || a.type || t("app.inbox.approvalUntitled")}
      </p>
      <p style={muted}>
        {[a.metadata?.toolName, amount ? t("app.inbox.amount", { value: amount }) : null, when(a.createdAt, locale), expires ? t("app.inbox.expires", { value: expires }) : null].filter(Boolean).join(" · ")}
      </p>
      {a.artifact && <ArtifactView artifact={a.artifact} t={t} />}
      {isInput && (
        <div style={{ marginTop: 8 }}>
          <label htmlFor={`answer-${a.id}`} style={{ ...muted, display: "block", marginBottom: 4 }}>{t("app.inbox.answerLabel")}</label>
          <textarea id={`answer-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} rows={2}
            style={{ width: "100%", padding: "6px 10px", borderRadius: 10, fontSize: 16, background: "var(--color-surface)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" style={btnPrimary} disabled={busy || (isInput && !note.trim())} onClick={() => onDecide(a, "APPROVED", isInput ? note.trim() : undefined)}>
          {busy ? t("app.inbox.deciding") : t("app.inbox.approve")}
        </button>
        <button type="button" style={btn} disabled={busy} onClick={() => onDecide(a, "REJECTED")}>{t("app.inbox.reject")}</button>
      </div>
      {error && <p role="alert" style={{ ...muted, color: "var(--color-error)", marginTop: 6 }}>{error}</p>}
    </li>
  );
}

export function ApprovalGroups({ groups, busyIds, errorByApproval, onDecide, t, locale }: {
  groups: InboxApprovalGroup[]; busyIds: ReadonlySet<string>; errorByApproval: Record<string, string>;
  onDecide: (a: InboxApproval, d: "APPROVED" | "REJECTED", note?: string) => void; t: T; locale: string;
}) {
  return (
    <ul style={{ display: "grid", gap: 12, listStyle: "none", margin: 0, padding: 0 }}>
      {groups.map((g) => (
        <li key={g.runId} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <h3 style={{ fontWeight: 700, color: "var(--color-on-surface)" }}>{g.runTitle ?? t("app.inbox.jobUntitled")}</h3>
            <Link href={`/runs/${encodeURIComponent(g.runId)}`} style={{ color: "var(--color-primary)", fontSize: 13, fontWeight: 600 }}>
              {t("app.inbox.openRun")}
            </Link>
          </div>
          <ul style={{ display: "grid", gap: 10, listStyle: "none", margin: 0, padding: 0 }}>
            {g.approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} busy={busyIds.has(a.id)} error={errorByApproval[a.id]} onDecide={onDecide} t={t} locale={locale} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export type ReceiptState = { status: "loading" } | { status: "none" } | { status: "error" } | { status: "ready"; receipt: JobReceipt };

export function ReceiptPanel({ state, t, locale }: { state: ReceiptState; t: T; locale: string }) {
  let body: React.ReactNode;
  if (state.status === "loading") body = <p style={muted}>{t("app.inbox.receipt.loading")}</p>;
  else if (state.status === "none") body = <p style={muted}>{t("app.inbox.receipt.none")}</p>;
  else if (state.status === "error") body = <p role="alert" style={{ ...muted, color: "var(--color-error)" }}>{t("app.inbox.receipt.error")}</p>;
  else {
    const r = state.receipt;
    const v = receiptVerified(r);
    const cost = money(r.costUsd, locale);
    const ev = Array.isArray(r.evidence) ? r.evidence : [];
    body = (
      <div style={{ display: "grid", gap: 6 }}>
        <p style={{ fontWeight: 700, color: v === true ? "var(--color-primary)" : "var(--color-on-surface)" }}>
          {v === true ? "✓ " : v === false ? "! " : ""}
          {v === true ? t("app.inbox.receipt.verified") : v === false ? t("app.inbox.receipt.unverified") : t("app.inbox.receipt.noStatus")}
        </p>
        <p style={muted}>{v === true ? t("app.inbox.receipt.verifiedHint") : v === false ? t("app.inbox.receipt.unverifiedHint") : ""}</p>
        <p style={muted}>{[t("app.inbox.receipt.outcome", { value: (["COMPLETED", "FAILED", "CANCELLED"].includes(r.outcome) ? t(`app.inbox.state.${r.outcome}`) : r.outcome) }), cost ? t("app.inbox.cost", { value: cost }) : null, when(r.createdAt, locale)].filter(Boolean).join(" · ")}</p>
        {ev.length === 0 ? <p style={muted}>{t("app.inbox.receipt.noEvidence")}</p> : (
          <ul style={{ margin: 0, paddingInlineStart: 18, ...muted }}>
            {ev.map((e, i) => (
              <li key={`${e.kind}-${e.ref}-${i}`} style={{ overflowWrap: "anywhere" }}>
                <strong>{e.kind}</strong> {e.ref}{e.ok === true ? ` · ${t("app.inbox.receipt.passed")}` : e.ok === false ? ` · ${t("app.inbox.receipt.failed")}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <div role="region" aria-label={t("app.inbox.receipt.title")} aria-live="polite" style={{ marginTop: 10, padding: 12, borderRadius: 10, background: "var(--color-surface-container-low)" }}>{body}</div>;
}

export function RunRow({ run, t, locale, busy, message, receipt, steerOpen, onAction, onSteerToggle, onSteerSend, onReceiptToggle }: {
  run: InboxRun; t: T; locale: string; busy: boolean; message: { kind: "ok" | "error"; text: string } | null;
  receipt: ReceiptState | null; steerOpen: boolean;
  onAction: (a: Exclude<RunAction, "steer">) => void; onSteerToggle: () => void;
  onSteerSend: (text: string) => Promise<boolean>; onReceiptToggle: () => void;
}) {
  const [steerText, setSteerText] = useState("");
  const actions = allowedActions(run);
  const cost = money(run.costUsd, locale);
  const updated = when(run.updatedAt, locale);
  const title = run.pipeline?.name ?? t("app.inbox.jobUntitled");
  return (
    <li style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <Link href={`/runs/${encodeURIComponent(run.id)}`} style={{ fontWeight: 700, color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{title}</Link>
          <p style={muted}>{[run.pipeline?.company?.name, cost ? t("app.inbox.cost", { value: cost }) : null, updated ? t("app.inbox.updated", { value: updated }) : null].filter(Boolean).join(" · ")}</p>
        </div>
        {run.bucket && <span className="bv-pill" style={{ alignSelf: "flex-start", fontSize: 11 }}>{t(`app.inbox.bucket.${run.bucket}`)}</span>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {actions.map((a) => a === "steer" ? (
          <button key={a} type="button" style={btn} disabled={busy} aria-expanded={steerOpen} onClick={onSteerToggle}>{t("app.inbox.action.steer")}</button>
        ) : (
          <button key={a} type="button" style={a === "resume" || a === "retry" ? btnPrimary : btn} disabled={busy} onClick={() => onAction(a)}>{t(`app.inbox.action.${a}`)}</button>
        ))}
        <button type="button" style={btn} aria-expanded={receipt !== null} onClick={onReceiptToggle}>
          {receipt ? t("app.inbox.receipt.hide") : t("app.inbox.action.receipt")}
        </button>
      </div>
      {steerOpen && (
        <form style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}
          onSubmit={(e) => { e.preventDefault(); const v = steerText.trim(); if (v) void onSteerSend(v).then((ok) => { if (ok) setSteerText(""); }); }}>
          <label htmlFor={`steer-${run.id}`} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{t("app.inbox.steerLabel")}</label>
          <input id={`steer-${run.id}`} value={steerText} onChange={(e) => setSteerText(e.target.value)} maxLength={500}
            placeholder={t("app.inbox.steerPlaceholder")}
            style={{ flex: "1 1 200px", minHeight: 36, padding: "6px 10px", borderRadius: 10, fontSize: 16, background: "var(--color-surface)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" }} />
          <button type="submit" style={btnPrimary} disabled={busy || !steerText.trim()}>{t("app.inbox.steerSend")}</button>
        </form>
      )}
      {message && <p role={message.kind === "error" ? "alert" : "status"} style={{ ...muted, marginTop: 8, color: message.kind === "error" ? "var(--color-error)" : muted.color }}>{message.text}</p>}
      {receipt && <ReceiptPanel state={receipt} t={t} locale={locale} />}
    </li>
  );
}
