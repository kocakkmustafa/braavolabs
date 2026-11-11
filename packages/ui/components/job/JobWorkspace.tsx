"use client";
/**
 * BRA-UX-05b — Birleşik çalışma alanı (ADR-0004, 04-design.md §5.7/§7): iş sayfasında AYNI başlık altında kip morfu
 * Özet → Çıktı → Kaput (içerik 180 ms çapraz solar; hareket azaltma tercihinde kesme). Kipler `JobModes` ile çekmeceyle ortaktır.
 * Yalnız var olan uçlar: `GET /runs/:id`, `/runs/:id/handoffs`, `/runs/:id/receipt`, `/runs/:id/{pause,resume,retry,stop,steer}`.
 * Sohbet kipi YOK (sohbet ucu yok); "yakında" diye de gösterilmez. Bayrak kapalıyken bu bileşen hiç sunulmaz (`app/runs/[id]/page.tsx`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { actionErrorKey, effectiveState, type InboxRun } from "../../lib/inbox";
import { trySend } from "../../lib/inboxActions";
import { toJobRun } from "../../lib/ux-workspace/run";
import { stateKey } from "../../lib/ux-jobs/rows";
import type { T } from "../inbox/InboxParts";
import JobModes, { type JobAct } from "./JobModes";

type Load = { status: "loading" } | { status: "error" } | { status: "notFound" } | { status: "ready"; run: InboxRun };
const POLL_MS = 10_000;
const muted = { color: "var(--color-on-surface-variant)", fontSize: 13 } as const;
const btn = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
} as const;

export default function JobWorkspace() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const rtl = locale === "ar";
  const { token, hydrated } = useAuthGuard();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const seq = useRef(0);
  const lock = useRef(false);
  const readyFor = useRef<string | null>(null); // hazır iş kimliği: token yenilenince sayfa sökülmez (sekme/yazılan metin kalır)

  const fetchRun = useCallback(async (silent = false) => {
    if (!token || !runId) return;
    const my = ++seq.current;
    if (!silent) setLoad({ status: "loading" });
    try {
      const run = toJobRun(await api.getRun(token, runId));
      if (my !== seq.current) return;
      if (run) { readyFor.current = run.id; setLoad({ status: "ready", run }); }
      else if (!silent) setLoad({ status: "notFound" });
    } catch (e) {
      if (my !== seq.current) return;
      const code = (e as { status?: number } | null)?.status;
      if (code === 404 || code === 403) setLoad({ status: "notFound" });
      else if (!silent) setLoad({ status: "error" });
      else setLoad((p) => (p.status === "ready" ? p : { status: "error" })); // hazır sayfa bayat kalır; yükleniyorda takılmaz
    }
  }, [token, runId]);

  useEffect(() => {
    if (!hydrated || !token) return;
    const same = readyFor.current === runId;
    if (!same) { readyFor.current = null; setMessage(null); }
    void fetchRun(same);
  }, [hydrated, token, runId, fetchRun]);

  // Canlı güncelleme: eski sayfadaki akışın yerine var olan GET /runs/:id yoklaması; yalnız etkin durumda, sekme görünürken, eylem sürmüyorken.
  const liveState = load.status === "ready" ? effectiveState(load.run) : null;
  const polling = liveState === "RUNNING" || liveState === "RESUMING" || liveState === "NEEDS_APPROVAL" || liveState === "PLANNED" || liveState === "READY";
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => { if (!lock.current && document.visibilityState === "visible") void fetchRun(true); }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, fetchRun]);

  const act = async (a: JobAct) => {
    if (!token || !runId || lock.current) return;
    lock.current = true; setBusy(true);
    const r = await trySend(() => api.runAction(token, runId, a));
    if (r.ok) { setMessage({ kind: "ok", text: t("app.inbox.actionOk") }); await fetchRun(true); }
    else setMessage({ kind: "error", text: t(actionErrorKey(r.err)) });
    lock.current = false; setBusy(false);
  };
  const steer = async (text: string): Promise<boolean> => {
    if (!token || !runId || lock.current) return false;
    lock.current = true; setBusy(true);
    const r = await trySend(() => api.steerRun(token, runId, text));
    setMessage({ kind: r.ok ? "ok" : "error", text: r.ok ? t("app.inbox.steerSent") : t(actionErrorKey(r.err)) });
    lock.current = false; setBusy(false);
    return r.ok;
  };

  const run = load.status === "ready" ? load.run : null;
  const title = run ? (run.pipeline?.name || t("app.inbox.jobUntitled")) : t("app.jobs.title");
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (run) headingRef.current?.focus(); }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section data-testid="job-workspace" aria-label={t("app.workspace.label", { title })} className="max-w-3xl mx-auto px-4 sm:px-6 py-8" style={{ display: "grid", gap: 14 }}>
      <nav aria-label={t("app.jobs.title")}>
        <Link href="/inbox" style={{ ...muted, textDecoration: "underline" }}>{t("app.workspace.back")}</Link>
      </nav>
      {!run && <h1 className="sr-only">{t("app.jobs.title")}</h1>}
      {load.status === "loading" && <p role="status" aria-busy="true" style={muted}>{t("app.workspace.loading")}</p>}
      {load.status === "notFound" && <p role="alert" style={{ color: "var(--color-on-surface)" }}>{t("app.workspace.notFound")}</p>}
      {load.status === "error" && (
        <div role="alert" style={{ display: "grid", gap: 8 }}>
          <strong style={{ color: "var(--color-on-surface)" }}>{t("app.workspace.errorTitle")}</strong>
          <span style={muted}>{t("app.workspace.errorBody")}</span>
          <div><button type="button" style={btn} onClick={() => void fetchRun()}>{t("app.inbox.retryLoad")}</button></div>
        </div>
      )}
      {run && token && (
        <article style={{ display: "grid", gap: 12, background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)", borderRadius: 14, padding: 16, alignContent: "start" }}>
          <header style={{ display: "grid", gap: 4 }}>
            <h1 ref={headingRef} tabIndex={-1} className="bv-headline" style={{ margin: 0, overflowWrap: "anywhere", color: "var(--color-on-surface)" }}>{title}</h1>
            <p style={muted}>{run.pipeline?.company?.name ?? "—"} · {t(stateKey(run))}</p>
          </header>
          <JobModes run={run} token={token} t={t} locale={locale} rtl={rtl} busy={busy} message={message} onAction={(a) => void act(a)} onSteer={steer}
            extraLinks={<Link href={`/runs/${encodeURIComponent(run.id)}?view=classic`} style={{ ...muted, alignSelf: "center", textDecoration: "underline" }}>{t("app.workspace.classic")}</Link>} />
        </article>
      )}
    </section>
  );
}
