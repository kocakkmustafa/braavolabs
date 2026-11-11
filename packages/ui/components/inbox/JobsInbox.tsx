"use client";
/**
 * BRA-UX-05c — İşler omurgası (ADR-0004; 04e `/inbox` üzerine): 4 kova, satırda şirket · durum · maliyet, onay kovasında risk,
 * iş çekmecesi (Özet/Çıktı/Kaput). Yalnız var olan uçlar: `/runs?bucket=`, `/approvals?groupBy=run`, `/approvals/:id/decide`,
 * `/runs/:id/{pause,resume,retry,stop}`, `/runs/:id/steer`, `/runs/:id`, `/runs/:id/handoffs`, `/runs/:id/receipt`.
 * Satırda ajan adı ve koşu riski YOK: liste ucu bu alanları vermiyor (BACKLOG `BRA-UX-API-04`); uydurulmaz.
 * Bayrak kapalıyken bu bileşen hiç sunulmaz (`app/inbox/page.tsx`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { INBOX_TABS, actionErrorKey, mergeApprovalGroups, mergeById, type InboxApproval, type InboxApprovalGroup, type InboxRun } from "../../lib/inbox";
import { createRowLock, failLoad, finishLoad, refreshGroupsFirstPage, refreshRunsFirstPage, startLoad, type Load } from "../../lib/inboxState";
import { decideResult, decisionMessageKey, refreshesLists, trySend } from "../../lib/inboxActions";
import { approvalRisk, stateKey, verificationKey } from "../../lib/ux-jobs/rows";
import type { InboxBucket } from "@ai-company-os/core";
import { ApprovalGroups, BucketTabs, EmptyBox, ErrorBox, money, type T } from "./InboxParts";
import JobDrawer from "./JobDrawer";

const EMPTY_KEY: Record<InboxBucket, string> = {
  working: "app.inbox.emptyWorking", needs_approval: "app.inbox.emptyNeedsApproval", done: "app.inbox.emptyDone", stuck: "app.inbox.emptyStuck",
};
const FIRST_PAGE = 25;
const muted = { color: "var(--color-on-surface-variant)", fontSize: 13 } as const;
const card = { background: "var(--color-surface-container)", border: "1px solid var(--color-surface-container-high)", borderRadius: 14, padding: 14 } as const;
const btn = {
  minHeight: 40, padding: "8px 16px", borderRadius: 10, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
} as const;

export default function JobsInbox() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const rtl = locale === "ar";
  const { token, hydrated } = useAuthGuard();
  const [tab, setTab] = useState<InboxBucket>(INBOX_TABS[0]);
  const [runs, setRuns] = useState<Load<InboxRun[]>>({ status: "loading" });
  const [groups, setGroups] = useState<Load<InboxApprovalGroup[]>>({ status: "loading" });
  const [open, setOpen] = useState<InboxRun | null>(null);
  const [busyRuns, setBusyRuns] = useState<ReadonlySet<string>>(new Set());
  const [busyApprovals, setBusyApprovals] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ runId: string; kind: "ok" | "error"; text: string } | null>(null);
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const runsSeq = useRef(0);
  const groupsSeq = useRef(0);
  const runLock = useRef(createRowLock());
  const approvalLock = useRef(createRowLock());

  const loadRuns = useCallback(async (bucket: InboxBucket, cursor: string | null, silent = false, dropId?: string) => {
    if (!token) return;
    const seq = ++runsSeq.current;
    setRuns((p) => startLoad(p, cursor, silent));
    try {
      const page = await api.inboxRuns(token, bucket, cursor);
      if (seq !== runsSeq.current) return;
      setRuns((p) => finishLoad<InboxRun[]>(p, cursor, silent, page.runs, page.nextCursor, mergeById,
        (old, inc) => refreshRunsFirstPage(old, inc, dropId), (old, inc) => old.length > inc.length));
    } catch {
      if (seq !== runsSeq.current) return;
      setRuns((p) => failLoad(p, cursor, silent));
    }
  }, [token]);

  const loadGroups = useCallback(async (cursor: string | null, silent = false, droppedId?: string) => {
    if (!token) return;
    const seq = ++groupsSeq.current;
    setGroups((p) => startLoad(p, cursor, silent));
    try {
      const page = await api.inboxApprovalGroups(token, cursor);
      if (seq !== groupsSeq.current) return;
      const count = (g: InboxApprovalGroup[]) => g.reduce((n, x) => n + x.approvals.length, 0);
      setGroups((p) => finishLoad<InboxApprovalGroup[]>(p, cursor, silent, page.groups, page.nextCursor, mergeApprovalGroups,
        (old, inc) => refreshGroupsFirstPage(old, inc, droppedId), (old, inc) => count(old) > Math.max(count(inc), FIRST_PAGE - 1)));
    } catch {
      if (seq !== groupsSeq.current) return;
      setGroups((p) => failLoad(p, cursor, silent));
    }
  }, [token]);

  useEffect(() => { if (hydrated && token) void loadRuns(tab, null); }, [hydrated, token, tab, loadRuns]);
  useEffect(() => { if (hydrated && token && tab === "needs_approval") void loadGroups(null); }, [hydrated, token, tab, loadGroups]);

  const refresh = () => { void loadRuns(tab, null); if (tab === "needs_approval") void loadGroups(null); };

  /** Çekmece kapanınca odak, açan satırın düğmesine döner (yoksa panele). */
  const close = useCallback((runId?: string) => {
    setOpen(null);
    requestAnimationFrame(() => {
      const opener = runId ? document.getElementById(`job-open-${runId}`) : null;
      (opener ?? document.getElementById("inbox-panel"))?.focus();
    });
  }, []);
  const lockRun = (id: string, on: boolean) => { if (on) runLock.current.acquire(id); else runLock.current.release(id); setBusyRuns(runLock.current.snapshot()); };

  const runAction = async (run: InboxRun, action: "resume" | "retry" | "pause" | "stop") => {
    if (!token || !runLock.current.acquire(run.id)) return;
    setBusyRuns(runLock.current.snapshot());
    const r = await trySend(() => api.runAction(token, run.id, action));
    if (r.ok) {
      // İş kova değiştirir: çekmece bayat durumla eylem sunmasın; sonuç sayfa düzeyinde duyurulur.
      setMessage({ runId: run.id, kind: "ok", text: t("app.inbox.actionOk") });
      void loadRuns(tab, null, true, run.id);
      close(run.id);
    } else setMessage({ runId: run.id, kind: "error", text: t(actionErrorKey(r.err)) });
    lockRun(run.id, false);
  };

  const steer = async (run: InboxRun, text: string): Promise<boolean> => {
    if (!token || !runLock.current.acquire(run.id)) return false;
    setBusyRuns(runLock.current.snapshot());
    const r = await trySend(() => api.steerRun(token, run.id, text));
    setMessage({ runId: run.id, kind: r.ok ? "ok" : "error", text: r.ok ? t("app.inbox.steerSent") : t(actionErrorKey(r.err)) });
    lockRun(run.id, false);
    return r.ok;
  };

  const decide = async (a: InboxApproval, decision: "APPROVED" | "REJECTED", note?: string) => {
    if (!token || !approvalLock.current.acquire(a.id)) return;
    setBusyApprovals(approvalLock.current.snapshot());
    setApprovalErrors(({ [a.id]: _, ...rest }) => rest);
    const res = await decideResult(() => api.decideApproval(token, a.id, decision, note));
    if (res.kind === "claimFailed") {
      const title = groups.status === "ready" ? groups.data.find((g) => g.runId === a.runId)?.runTitle : null;
      setNotice(t("app.inbox.claimFailed", { run: title ?? a.runId }));
    }
    const key = decisionMessageKey(res.kind);
    if (key) setApprovalErrors((m) => ({ ...m, [a.id]: t(key) }));
    if (refreshesLists(res.kind)) { void loadGroups(null, true, a.id); void loadRuns(tab, null, true); }
    approvalLock.current.release(a.id);
    setBusyApprovals(approvalLock.current.snapshot());
  };

  if (!hydrated || !token) {
    return <div className="flex items-center justify-center min-h-[60vh]" role="status" aria-label={t("app.inbox.loading")}>
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-surface-container-highest)", borderTopColor: "var(--color-primary)" }} />
    </div>;
  }

  const moreBtn = (loading: boolean, failed: boolean, onClick: () => void) => (
    <div style={{ textAlign: "center", marginTop: 12 }}>
      {failed && <p role="alert" style={{ ...muted, color: "var(--color-error)", marginBottom: 6 }}>{t("app.inbox.loadMoreError")}</p>}
      <button type="button" disabled={loading} onClick={onClick} style={btn}>{loading ? t("app.inbox.loadingMore") : t("app.inbox.loadMore")}</button>
    </div>
  );
  const riskLabel = (a: InboxApproval) => { const r = approvalRisk(a as { details?: { risk?: unknown } | null }); return r ? t("app.jobs.riskLabel", { value: t(`app.jobs.risk.${r}`) }) : null; };
  const drawerRun = open && runs.status === "ready" ? runs.data.find((r) => r.id === open.id) ?? open : open;

  return (
    <div data-testid="jobs-inbox" className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header style={{ marginBottom: 16 }}>
        <h1 className="bv-headline text-on-surface">{t("app.jobs.title")}</h1>
        <p className="bv-caption mt-1">{t("app.inbox.subtitle")}</p>
      </header>
      {notice && (
        <div role="alert" style={{ ...card, marginBottom: 12, borderColor: "var(--color-error)", display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <p style={{ color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{notice}</p>
          <button type="button" onClick={() => setNotice(null)} style={{ ...btn, minHeight: 32, padding: "4px 10px" }}>{t("app.inbox.dismiss")}</button>
        </div>
      )}
      {message && !open && <p role={message.kind === "error" ? "alert" : "status"} style={{ ...muted, marginBottom: 8, color: message.kind === "error" ? "var(--color-error)" : muted.color }}>{message.text}</p>}
      <BucketTabs tabs={INBOX_TABS} active={tab} onChange={(b) => { setTab(b); setOpen(null); setMessage(null); }} t={t} rtl={rtl} />
      <div className={drawerRun ? "lg:grid lg:gap-5 lg:grid-cols-[minmax(0,1fr)_400px]" : ""} style={{ marginTop: 16 }}>
        <div id="inbox-panel" role="tabpanel" aria-labelledby={`inbox-tab-${tab}`} tabIndex={0} style={{ display: "grid", gap: 20, alignContent: "start", minWidth: 0 }}>
          {tab === "needs_approval" && (
            <section aria-labelledby="jobs-approvals-h">
              <h2 id="jobs-approvals-h" style={{ fontWeight: 700, marginBottom: 8, color: "var(--color-on-surface)" }}>{t("app.inbox.approvalsTitle")}</h2>
              {groups.status === "loading" && <p role="status" style={muted}>{t("app.inbox.loading")}</p>}
              {groups.status === "error" && <ErrorBox t={t} title={t("app.inbox.approvalsErrorTitle")} body={t("app.inbox.errorBody")} onRetry={() => void loadGroups(null)} />}
              {groups.status === "ready" && (groups.data.length === 0 ? <EmptyBox text={t("app.inbox.approvalsEmpty")} /> : (
                <>
                  <ApprovalGroups groups={groups.data} busyIds={busyApprovals} errorByApproval={approvalErrors} onDecide={decide} t={t} locale={locale} riskLabel={riskLabel} />
                  {groups.cursor && moreBtn(groups.more, groups.moreError, () => void loadGroups(groups.cursor))}
                </>
              ))}
            </section>
          )}
          <section aria-label={t(`app.inbox.bucket.${tab}`)}>
            {tab === "needs_approval" && <h2 style={{ fontWeight: 700, marginBottom: 8, color: "var(--color-on-surface)" }}>{t("app.inbox.jobsTitle")}</h2>}
            {tab === "stuck" && <p role="note" style={{ ...muted, marginBottom: 8 }}>{t("app.jobs.stuckNote")}</p>}
            {runs.status === "loading" && <p role="status" style={muted}>{t("app.inbox.loading")}</p>}
            {runs.status === "error" && <ErrorBox t={t} title={t("app.inbox.errorTitle")} body={t("app.inbox.errorBody")} onRetry={refresh} />}
            {runs.status === "ready" && (runs.data.length === 0 ? <EmptyBox text={t(EMPTY_KEY[tab])} /> : (
              <>
                <ul style={{ display: "grid", gap: 10, listStyle: "none", margin: 0, padding: 0 }}>
                  {runs.data.map((run) => {
                    const title = run.pipeline?.name ?? t("app.inbox.jobUntitled");
                    const cost = money(run.costUsd, locale);
                    const meta = [run.pipeline?.company?.name, t(stateKey(run)), cost, run.bucket === "done" ? t(`app.jobs.${verificationKey(run)}`) : null].filter(Boolean).join(" · ");
                    const selected = drawerRun?.id === run.id;
                    return (
                      <li key={run.id} data-testid="job-row" style={{ ...card, ...(selected ? { borderColor: "var(--color-primary)" } : {}) }}>
                        <button type="button" id={`job-open-${run.id}`} aria-label={t("app.jobs.openJob", { title })} aria-expanded={selected}
                          onClick={() => { setMessage(null); setOpen(selected ? null : run); }}
                          style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box" }}>
                          <strong style={{ color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{title}</strong>
                          <span style={{ ...muted, display: "block", marginTop: 2 }}>{meta}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {runs.cursor && moreBtn(runs.more, runs.moreError, () => void loadRuns(tab, runs.cursor))}
              </>
            ))}
          </section>
        </div>
        {drawerRun && (
          <JobDrawer run={drawerRun} token={token} t={t} locale={locale} rtl={rtl} busy={busyRuns.has(drawerRun.id)}
            message={message && message.runId === drawerRun.id ? message : null}
            onAction={(a) => void runAction(drawerRun, a)} onSteer={(text) => steer(drawerRun, text)} onClose={() => close(drawerRun.id)} />
        )}
      </div>
    </div>
  );
}
