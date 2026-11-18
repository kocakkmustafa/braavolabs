"use client";
/** BRA-UX-05c — iş çekmecesi. BRA-UX-05b: gövde (Özet/Çıktı/Kaput kipleri, eylemler) `components/job/JobModes`a taşındı; burada yalnız kabuk kalır. */
import { useEffect, useRef } from "react";
import Link from "next/link";
import type { InboxRun } from "../../lib/inbox";
import JobModes, { type JobAct } from "../job/JobModes";
import type { T } from "./InboxParts";

const btn: React.CSSProperties = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
};
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

export default function JobDrawer({ run, token, t, locale, rtl, busy, message, onAction, onSteer, onClose, codeChange = false }: {
  run: InboxRun; token: string; t: T; locale: string; rtl: boolean; busy: boolean; message: { kind: "ok" | "error"; text: string } | null;
  onAction: (a: JobAct) => void; onSteer: (text: string) => Promise<boolean>; onClose: () => void; codeChange?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const title = run.pipeline?.name ?? t("app.inbox.jobUntitled");

  useEffect(() => { heading.current?.focus(); }, [run.id]);
  useEffect(() => {
    // Yazı alanında/seçicide Esc çekmeceyi kapatmaz (yazılan yönlendirme kaybolmasın; seçici kendi açılırını kapatır).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside data-testid="job-drawer" aria-label={t("app.jobs.drawerLabel", { title })}
      className="fixed inset-0 z-40 overflow-auto p-4 lg:static lg:inset-auto lg:z-auto lg:p-4 lg:self-start"
      style={{ background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)", borderRadius: 14, display: "grid", gap: 12, alignContent: "start" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h2 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 17, fontWeight: 700, overflowWrap: "anywhere", color: "var(--color-on-surface)" }}>{title}</h2>
        <button type="button" style={btn} onClick={onClose} aria-label={t("app.jobs.close")}>✕</button>
      </div>
      <JobModes codeChange={codeChange} run={run} token={token} t={t} locale={locale} rtl={rtl} busy={busy} message={message} onAction={onAction} onSteer={onSteer}
        extraLinks={<Link href={`/runs/${encodeURIComponent(run.id)}`} style={{ ...muted, alignSelf: "center", textDecoration: "underline" }}>{t("app.jobs.openFull")}</Link>} />
    </aside>
  );
}
