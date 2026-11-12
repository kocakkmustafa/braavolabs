"use client";
/**
 * BRA-UX-05b — iş kipleri: aynı iş, üç derinlik (Özet → Çıktı → Kaput); Sade/Tam yalnız ayrıntı düzeyini değiştirir.
 * BRA-UX-05c'deki çekmecenin gövdesi buraya taşındı; hem çekmece (`JobDrawer`) hem iş sayfası (`JobWorkspace`) kullanır.
 * Sohbet kipi YOK (sohbet ucu yok; 04-design.md §3 E2), "yakında" diye de gösterilmez.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { allowedActions, nextTabIndex, type InboxRun } from "../../lib/inbox";
import { receiptFailureKind, trySend } from "../../lib/inboxActions";
import { loadKaput } from "../../lib/ux-jobs/kaput";
import { stateKey, verificationKey } from "../../lib/ux-jobs/rows";
import KaputPanel, { type KaputLoad } from "./KaputPanel";
import { ReceiptPanel, money, type ReceiptState, type T } from "../inbox/InboxParts";

type Tab = "summary" | "output" | "kaput";
const TABS: readonly Tab[] = ["summary", "output", "kaput"];

const btn: React.CSSProperties = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

export type JobAct = "resume" | "retry" | "pause" | "stop";

export default function JobModes({ run, token, t, locale, rtl, busy, message, onAction, onSteer, extraLinks }: {
  run: InboxRun; token: string; t: T; locale: string; rtl: boolean; busy: boolean; message: { kind: "ok" | "error"; text: string } | null;
  onAction: (a: JobAct) => void; onSteer: (text: string) => Promise<boolean>; extraLinks?: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const [full, setFull] = useState(false);
  const [kaput, setKaput] = useState<KaputLoad>({ status: "idle" });
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState("");
  const kSeq = useRef(0);
  const rSeq = useRef(0);

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
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <div role="tablist" aria-label={t("app.jobs.viewLabel")} onKeyDown={onTabKey} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" id={`job-tab-${id}`} aria-selected={tab === id} aria-controls="job-tabpanel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
              style={{ ...btn, ...(tab === id ? { background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "transparent" } : {}) }}>{t(`app.jobs.tab.${id}`)}</button>
          ))}
        </div>
        <label style={{ ...muted, marginInlineStart: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {t("app.jobs.detail.label")}
          <select value={full ? "full" : "simple"} onChange={(e) => setFull(e.target.value === "full")} style={{ minHeight: 44, padding: "0 8px" }}>
            <option value="simple">{t("app.jobs.detail.simple")}</option>
            <option value="full">{t("app.jobs.detail.full")}</option>
          </select>
        </label>
      </div>
      <div role="tabpanel" id="job-tabpanel" key={tab} className="job-mode-in" aria-labelledby={`job-tab-${tab}`} style={{ display: "grid", gap: 8, color: "var(--color-on-surface)" }}>
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
        {extraLinks}
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
    </>
  );
}
