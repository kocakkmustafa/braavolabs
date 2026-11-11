"use client";
/** BRA-UX-05c — iş çekmecesi: aynı iş, üç derinlik (Özet → Çıktı → Kaput); Sade/Tam yalnız ayrıntı düzeyini değiştirir. */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { actionErrorKey, allowedActions, nextTabIndex, type InboxRun } from "../../lib/inbox";
import { receiptFailureKind, trySend } from "../../lib/inboxActions";
import { loadKaput } from "../../lib/ux-jobs/kaput";
import { stateKey, verificationKey } from "../../lib/ux-jobs/rows";
import type { Kaput } from "../../lib/ux-lab/facts";
import { ReceiptPanel, money, type ReceiptState, type T } from "./InboxParts";

type Tab = "summary" | "output" | "kaput";
const TABS: readonly Tab[] = ["summary", "output", "kaput"];
type KaputLoad = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; kaput: Kaput };
type Act = "resume" | "retry" | "pause" | "stop";

const btn: React.CSSProperties = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

export default function JobDrawer({ run, token, t, locale, rtl, busy, message, onAction, onSteer, onClose }: {
  run: InboxRun; token: string; t: T; locale: string; rtl: boolean; busy: boolean; message: { kind: "ok" | "error"; text: string } | null;
  onAction: (a: Act) => void; onSteer: (text: string) => Promise<boolean>; onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const [full, setFull] = useState(false);
  const [kaput, setKaput] = useState<KaputLoad>({ status: "idle" });
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const kSeq = useRef(0);
  const rSeq = useRef(0);
  const title = run.pipeline?.name ?? t("app.inbox.jobUntitled");

  useEffect(() => { heading.current?.focus(); }, [run.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Başka işe geçilince önceki işin verisi sızmasın (`seq` gecikmiş yanıtı da eler).
  useEffect(() => { kSeq.current++; rSeq.current++; setTab("summary"); setKaput({ status: "idle" }); setReceipt(null); setSteerOpen(false); setSteerText(""); }, [run.id]);

  const fetchKaput = () => {
    const my = ++kSeq.current;
    setKaput({ status: "loading" });
    loadKaput(token, run.id).then((k) => { if (my === kSeq.current) setKaput({ status: "ready", kaput: k }); }, () => { if (my === kSeq.current) setKaput({ status: "error" }); });
  };
  const fetchReceipt = async () => {
    const my = ++rSeq.current;
    setReceipt({ status: "loading" });
    const r = await trySend(async () => { const rc = await api.runReceipt(token, run.id); if (my === rSeq.current) setReceipt({ status: "ready", receipt: rc }); });
    if (!r.ok && my === rSeq.current) setReceipt({ status: receiptFailureKind(r.err) });
  };
  useEffect(() => {
    if (tab === "kaput" && kaput.status === "idle") fetchKaput();
    if (tab === "output" && receipt === null) void fetchReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, run.id]);

  const actions = allowedActions(run);
  const cost = money(run.costUsd, locale);
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = nextTabIndex(e.key, TABS.indexOf(tab), TABS.length, rtl);
    if (i === null) return;
    e.preventDefault();
    setTab(TABS[i]);
    requestAnimationFrame(() => document.getElementById(`job-tab-${TABS[i]}`)?.focus());
  };

  return (
    <aside data-testid="job-drawer" aria-label={t("app.jobs.drawerLabel", { title })}
      className="fixed inset-0 z-40 overflow-auto p-4 lg:static lg:inset-auto lg:z-auto lg:p-4 lg:self-start"
      style={{ background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)", borderRadius: 14, display: "grid", gap: 12, alignContent: "start" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h2 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 17, fontWeight: 700, overflowWrap: "anywhere", color: "var(--color-on-surface)" }}>{title}</h2>
        <button type="button" style={btn} onClick={onClose} aria-label={t("app.jobs.close")}>✕</button>
      </div>
      <div role="tablist" aria-label={t("app.jobs.viewLabel")} onKeyDown={onTabKey} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" id={`job-tab-${id}`} aria-selected={tab === id} aria-controls="job-tabpanel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
            style={{ ...btn, ...(tab === id ? { background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "transparent" } : {}) }}>{t(`app.jobs.tab.${id}`)}</button>
        ))}
        <label style={{ ...muted, marginInlineStart: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {t("app.jobs.detail.label")}
          <select value={full ? "full" : "simple"} onChange={(e) => setFull(e.target.value === "full")} style={{ minHeight: 44, padding: "0 8px" }}>
            <option value="simple">{t("app.jobs.detail.simple")}</option>
            <option value="full">{t("app.jobs.detail.full")}</option>
          </select>
        </label>
      </div>
      <div role="tabpanel" id="job-tabpanel" aria-labelledby={`job-tab-${tab}`} style={{ display: "grid", gap: 8, color: "var(--color-on-surface)" }}>
        {tab === "summary" && (
          <>
            <div><strong>{t("app.jobs.field.status")}:</strong> {t(stateKey(run))} · <strong>{t("app.jobs.field.cost")}:</strong> {cost ?? "—"} · <strong>{t("app.jobs.field.company")}:</strong> {run.pipeline?.company?.name ?? "—"}</div>
            {run.bucket === "done" && <div>{t(`app.jobs.${verificationKey(run)}`)}</div>}
            {full && <div style={{ ...muted, overflowWrap: "anywhere" }} data-testid="job-full">{t("app.jobs.fullInfo", { id: run.id, state: run.state ?? run.status, updated: run.updatedAt })}</div>}
          </>
        )}
        {tab === "output" && (
          <>
            <div>{t(`app.jobs.${verificationKey(run)}`)}</div>
            {receipt && <ReceiptPanel state={receipt} t={t} locale={locale} />}
          </>
        )}
        {tab === "kaput" && <KaputPanel load={kaput} full={full} t={t} locale={locale} onRetry={fetchKaput} />}
      </div>
      {message && <p role={message.kind === "error" ? "alert" : "status"} style={{ ...muted, color: message.kind === "error" ? "var(--color-error)" : muted.color }}>{message.text}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {actions.map((a) => a === "steer" ? (
          <button key={a} type="button" style={btn} disabled={busy} aria-expanded={steerOpen} onClick={() => setSteerOpen((o) => !o)}>{t("app.inbox.action.steer")}</button>
        ) : (
          <button key={a} type="button" style={a === "resume" || a === "retry" ? btnPrimary : btn} disabled={busy} onClick={() => onAction(a)}>{t(`app.inbox.action.${a}`)}</button>
        ))}
        <Link href={`/runs/${encodeURIComponent(run.id)}`} style={{ ...muted, alignSelf: "center", textDecoration: "underline" }}>{t("app.jobs.openFull")}</Link>
      </div>
      {steerOpen && (
        <form style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          onSubmit={(e) => { e.preventDefault(); const v = steerText.trim(); if (v) void onSteer(v).then((ok) => { if (ok) { setSteerText(""); setSteerOpen(false); } }); }}>
          <label htmlFor="job-steer" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{t("app.inbox.steerLabel")}</label>
          <input id="job-steer" value={steerText} onChange={(e) => setSteerText(e.target.value)} maxLength={500} placeholder={t("app.inbox.steerPlaceholder")}
            style={{ flex: "1 1 200px", minHeight: 44, padding: "6px 10px", borderRadius: 10, fontSize: 16, background: "var(--color-surface)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" }} />
          <button type="submit" style={btnPrimary} disabled={busy || !steerText.trim()}>{t("app.inbox.steerSend")}</button>
        </form>
      )}
    </aside>
  );
}

function KaputPanel({ load, full, t, locale, onRetry }: { load: KaputLoad; full: boolean; t: T; locale: string; onRetry: () => void }) {
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
  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="job-kaput">
      <div>{t("app.jobs.kaput.summary", {
        steps: k.steps.length, tools: k.toolCallCount, cost: k.totalCostUsd === null ? "—" : (money(k.totalCostUsd, locale) ?? "—"), handoffs: k.handoffCount === null ? unknown : k.handoffCount,
      })}</div>
      {k.steps.length === 0 ? <span style={muted}>{t("app.jobs.kaput.noSteps")}</span> : (
        <ol style={{ margin: 0, paddingInlineStart: 20, display: "grid", gap: 6 }}>
          {k.steps.map((s) => (
            <li key={s.id}>{s.name} <span style={muted}>· {s.status}{full && s.costUsd !== null ? ` · ${money(s.costUsd, locale) ?? ""}` : ""}</span>
              {full && s.toolCalls.length > 0 && (
                <ul style={{ margin: "4px 0 0", paddingInlineStart: 16 }}>
                  {s.toolCalls.map((c) => <li key={c.id} style={muted}>{c.toolName} · {c.status}{c.durationMs !== null ? ` · ${c.durationMs} ms` : ""}{c.error ? ` · ${c.error}` : ""}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <p style={muted}>{t("app.jobs.kaput.later")}</p>
    </div>
  );
}
