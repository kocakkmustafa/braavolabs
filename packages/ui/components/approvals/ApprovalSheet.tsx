"use client";
/**
 * BRA-UX-05i — Onay sheet'i (tasarım §5.4). Masaüstünde yan panel, mobilde alt sheet. role="dialog" aria-modal, odak tuzağı, Esc kapatır.
 * Kaynak yoksa (null) "Bilgi yok" yazılır, ASLA uydurulmaz. Tehlikeli onayda (para / yüksek risk / geri alınamaz) tek dokunuş yok:
 * onay cümlesi yazılana dek "Onayla" devre dışıdır. Reddetme ikinci adım istemez. IME birleştirmesi sırasında Enter onay sayılmaz.
 */
import { useEffect, useRef, useState } from "react";
import { ArtifactCard } from "./ApprovalsLegacy";
import {
  canApprove, decisionNote, isDangerous, readDetails, reversibleKey, toolName,
  type CenterApproval,
} from "../../lib/ux-approvals/approval";

export type T = (key: string, values?: Record<string, string | number>) => string;
type LegacyT = Parameters<typeof ArtifactCard>[0]["t"];

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const label: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 12, fontWeight: 600, letterSpacing: 0 };
const value: React.CSSProperties = { color: "var(--color-on-surface)", fontSize: 14, overflowWrap: "anywhere" };
const btn: React.CSSProperties = {
  minHeight: 44, padding: "8px 16px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-highest)",
};
const field: React.CSSProperties = {
  width: "100%", minHeight: 44, padding: "8px 12px", borderRadius: 10, fontSize: 14,
  background: "var(--color-surface-container-lowest, var(--color-background))", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-outline-variant)",
};
const RISK_COLOR = { low: "var(--color-on-surface-variant)", medium: "var(--bv-status-running)", high: "#FF6B6B" } as const;

export default function ApprovalSheet({ approval, t, legacyT, locale, usd, when, busy, error, onDecide, onClose }: {
  approval: CenterApproval; t: T; legacyT: LegacyT; locale: string; usd: (n: number) => string; when: string | null;
  busy: boolean; error: string | null;
  onDecide: (id: string, decision: "APPROVED" | "REJECTED", note: string | undefined) => void; onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const composing = useRef(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");

  const details = readDetails(approval);
  const dangerous = isDangerous(approval);
  const phrase = t("app.approvalCenter.danger.phrase");
  const ok = canApprove(dangerous, typed, phrase, locale);
  const tool = toolName(approval);
  const cn = (k: string, v?: Record<string, string | number>) => t(`app.approvalCenter.${k}`, v);
  const unknown = cn("unknown");

  useEffect(() => { heading.current?.focus(); }, [approval.id]);
  useEffect(() => { setTyped(""); setReason(""); }, [approval.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (composing.current || e.nativeEvent.isComposing) return; // IME'yi iptal eder, sheet'i kapatmaz
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !root.current) return;
    const items = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root.current || active === heading.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const approve = () => { if (ok && !busy) onDecide(approval.id, "APPROVED", decisionNote(reason)); };
  const onPhraseKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return; // IME Enter'ı onay sayılmaz
    approve();
  };

  const rows: Array<[string, React.ReactNode]> = [
    [cn("field.what"), <span key="w">{approval.description}</span>],
    [cn("field.tool"), tool ?? unknown],
    [cn("field.permissions"), lines(details.permissions, unknown)],
    [cn("field.data"), lines(details.dataTransfer, unknown)],
    [cn("field.risk"), details.risk
      ? <span data-risk={details.risk} style={{ color: RISK_COLOR[details.risk], fontWeight: 700 }}>{cn(`riskLevel.${details.risk}`)}</span>
      : unknown],
    [cn("field.amount"), typeof approval.amountUsd === "number" ? usd(approval.amountUsd) : unknown],
    [cn("field.reversible"), cn(reversibleKey(details.reversible))],
  ];

  return (
    <>
      <div data-testid="approval-backdrop" aria-hidden="true" onClick={onClose} className="fixed inset-0 z-[110]" style={{ background: "rgba(0,0,0,0.45)" }} />
      <div
        ref={root} role="dialog" aria-modal="true" data-testid="approval-sheet"
        aria-label={cn("sheetLabel", { title: approval.description })} onKeyDown={onKeyDown}
        className="ac-sheet fixed z-[111] inset-x-0 bottom-0 overflow-auto p-4 lg:top-0 lg:bottom-0 lg:start-auto lg:end-0 lg:w-[440px]"
        style={{
          background: "var(--color-surface-container)", color: "var(--color-on-surface)",
          borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-high)", display: "grid", gap: 14, alignContent: "start",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <h2 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 17, fontWeight: 700, overflowWrap: "anywhere" }}>{approval.description}</h2>
          <button type="button" style={btn} onClick={onClose} aria-label={cn("close")}>✕</button>
        </div>

        <dl data-testid="approval-fields" style={{ margin: 0, display: "grid", gap: 10 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "grid", gap: 2 }}>
              <dt style={label}>{k}</dt>
              <dd style={{ ...value, margin: 0 }}>{v}</dd>
            </div>
          ))}
          <div style={{ display: "grid", gap: 2 }}>
            <dt style={label}>{cn("field.draft")}</dt>
            <dd style={{ ...value, margin: 0 }}>{approval.artifact ? <ArtifactCard artifact={approval.artifact} t={legacyT} /> : unknown}</dd>
          </div>
          {when && (
            <div style={{ display: "grid", gap: 2 }}>
              <dt style={label}>{cn("field.requested")}</dt>
              <dd style={{ ...value, margin: 0 }}>{when}</dd>
            </div>
          )}
        </dl>

        {dangerous && (
          <div data-testid="approval-danger" style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderStyle: "solid", borderColor: "rgba(255,77,77,0.35)", background: "rgba(255,77,77,0.06)" }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{cn("danger.title")}</p>
            <p id="approval-danger-body" style={{ margin: 0, fontSize: 13, color: "var(--color-on-surface-variant)" }}>{cn("danger.body")}</p>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span>{cn("danger.phraseLabel", { phrase })}</span>
              <input
                data-testid="approval-confirm-input" type="text" value={typed} autoComplete="off" spellCheck={false} style={field}
                aria-describedby="approval-danger-body"
                onChange={(e) => setTyped(e.target.value)} onKeyDown={onPhraseKey}
                onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span>{cn("danger.reasonLabel")}</span>
              <textarea data-testid="approval-reason" value={reason} rows={2} maxLength={500} style={{ ...field, minHeight: 64 }} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        )}

        {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: "#FF8A8A" }}>{error}</p>}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" data-testid="approval-reject" disabled={busy} style={{ ...btn, flex: "1 1 120px" }} onClick={() => onDecide(approval.id, "REJECTED", undefined)}>
            {t("app.approvals.reject")}
          </button>
          <button
            type="button" data-testid="approval-approve" disabled={busy || !ok} onClick={approve}
            style={{ ...btn, flex: "1 1 120px", background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "transparent", opacity: busy || !ok ? 0.5 : 1, cursor: busy || !ok ? "not-allowed" : "pointer" }}
          >
            {t("app.approvals.approve")}
          </button>
        </div>
      </div>
    </>
  );
}

function lines(items: string[] | null, unknown: string): React.ReactNode {
  if (!items) return unknown;
  return items.map((s, i) => <div key={i}>{s}</div>);
}
