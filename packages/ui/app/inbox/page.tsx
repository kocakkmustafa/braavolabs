"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import {
  INBOX_TABS, actionErrorKey, mergeApprovalGroups, mergeById,
  type InboxApproval, type InboxApprovalGroup, type InboxRun,
} from "../../lib/inbox";
import {
  createRowLock, failLoad, finishLoad, refreshGroupsFirstPage, refreshRunsFirstPage, startLoad, type Load,
} from "../../lib/inboxState";
import { decideResult, decisionMessageKey, receiptFailureKind, refreshesLists, trySend } from "../../lib/inboxActions";
import type { InboxBucket } from "@ai-company-os/core";
import {
  ApprovalGroups, BucketTabs, EmptyBox, ErrorBox, RunRow, type ReceiptState, type T,
} from "../../components/inbox/InboxParts";

const EMPTY_KEY: Record<InboxBucket, string> = {
  working: "app.inbox.emptyWorking", needs_approval: "app.inbox.emptyNeedsApproval",
  done: "app.inbox.emptyDone", stuck: "app.inbox.emptyStuck",
};
const FIRST_PAGE = 25;

export default function InboxPage() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const rtl = locale === "ar";
  const { token, hydrated } = useAuthGuard();
  const [tab, setTab] = useState<InboxBucket>(INBOX_TABS[0]);
  const [runs, setRuns] = useState<Load<InboxRun[]>>({ status: "loading" });
  const [groups, setGroups] = useState<Load<InboxApprovalGroup[]>>({ status: "loading" });
  const [busyRuns, setBusyRuns] = useState<ReadonlySet<string>>(new Set());
  const [busyApprovals, setBusyApprovals] = useState<ReadonlySet<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, { kind: "ok" | "error"; text: string }>>({});
  const [steerOpen, setSteerOpen] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ReceiptState>>({});
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

  /** Sessiz yenileme sonrası odak gövdeye düştüyse panele döner. */
  const restoreFocus = () => requestAnimationFrame(() => {
    if (typeof document !== "undefined" && (!document.activeElement || document.activeElement === document.body)) document.getElementById("inbox-panel")?.focus();
  });

  const setMsg = (id: string, kind: "ok" | "error", text: string) => setMessages((m) => ({ ...m, [id]: { kind, text } }));
  const lockRun = (id: string, on: boolean) => { if (on) runLock.current.acquire(id); else runLock.current.release(id); setBusyRuns(runLock.current.snapshot()); };
  const lockApproval = (id: string, on: boolean) => { if (on) approvalLock.current.acquire(id); else approvalLock.current.release(id); setBusyApprovals(approvalLock.current.snapshot()); };

  const runAction = async (run: InboxRun, action: "resume" | "retry" | "pause" | "stop") => {
    if (!token || !runLock.current.acquire(run.id)) return;
    setBusyRuns(runLock.current.snapshot());
    const r = await trySend(() => api.runAction(token, run.id, action));
    if (r.ok) { setMsg(run.id, "ok", t("app.inbox.actionOk")); void loadRuns(tab, null, true, run.id); restoreFocus(); }
    else setMsg(run.id, "error", t(actionErrorKey(r.err)));
    lockRun(run.id, false);
  };

  const steer = async (run: InboxRun, text: string): Promise<boolean> => {
    if (!token || !runLock.current.acquire(run.id)) return false;
    setBusyRuns(runLock.current.snapshot());
    const r = await trySend(() => api.steerRun(token, run.id, text));
    if (r.ok) { setMsg(run.id, "ok", t("app.inbox.steerSent")); setSteerOpen(null); }
    else setMsg(run.id, "error", t(actionErrorKey(r.err)));
    lockRun(run.id, false);
    return r.ok;
  };

  const toggleReceipt = async (run: InboxRun) => {
    if (!token) return;
    if (receipts[run.id]) { setReceipts(({ [run.id]: _, ...rest }) => rest); return; }
    setReceipts((r) => ({ ...r, [run.id]: { status: "loading" } }));
    const r = await trySend(async () => { const receipt = await api.runReceipt(token, run.id); setReceipts((s) => s[run.id] ? { ...s, [run.id]: { status: "ready", receipt } } : s); });
    if (!r.ok) setReceipts((s) => s[run.id] ? { ...s, [run.id]: { status: receiptFailureKind(r.err) } } : s);
  };

  const decide = async (a: InboxApproval, decision: "APPROVED" | "REJECTED", note?: string) => {
    if (!token || !approvalLock.current.acquire(a.id)) return;
    setBusyApprovals(approvalLock.current.snapshot());
    setApprovalErrors(({ [a.id]: _, ...rest }) => rest);
    const res = await decideResult(() => api.decideApproval(token, a.id, decision, note));
    if (res.kind === "claimFailed") {
      // Karar kaydedildi ama devir alınamadı: kullanıcı "onaylandı" sanmasın (kalıcı uyarı).
      const title = groups.status === "ready" ? groups.data.find((g) => g.runId === a.runId)?.runTitle : null;
      setNotice(t("app.inbox.claimFailed", { run: title ?? a.runId }));
    }
    const key = decisionMessageKey(res.kind);
    if (key) setApprovalErrors((m) => ({ ...m, [a.id]: t(key) }));
    if (refreshesLists(res.kind)) { void loadGroups(null, true, a.id); void loadRuns(tab, null, true); restoreFocus(); }
    lockApproval(a.id, false);
  };

  if (!hydrated || !token) {
    return <div className="flex items-center justify-center min-h-[60vh]" role="status" aria-label={t("app.inbox.loading")}>
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-surface-container-highest)", borderTopColor: "var(--color-primary)" }} />
    </div>;
  }

  const muted = { color: "var(--color-on-surface-variant)", fontSize: 13 } as const;
  const moreBtn = (loading: boolean, failed: boolean, onClick: () => void) => (
    <div style={{ textAlign: "center", marginTop: 12 }}>
      {failed && <p role="alert" style={{ ...muted, color: "var(--color-error)", marginBottom: 6 }}>{t("app.inbox.loadMoreError")}</p>}
      <button type="button" disabled={loading} onClick={onClick}
        style={{ minHeight: 40, padding: "8px 16px", borderRadius: 10, fontWeight: 600, cursor: "pointer", background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" }}>
        {loading ? t("app.inbox.loadingMore") : t("app.inbox.loadMore")}
      </button>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <header style={{ marginBottom: 16 }}>
        <h1 className="bv-headline text-on-surface">{t("app.inbox.title")}</h1>
        <p className="bv-caption mt-1">{t("app.inbox.subtitle")}</p>
      </header>
      {notice && (
        <div role="alert" style={{ marginBottom: 12, padding: 12, borderRadius: 12, border: "1px solid var(--color-error)", background: "var(--color-surface-container)", display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <p style={{ color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{notice}</p>
          <button type="button" onClick={() => setNotice(null)} style={{ minHeight: 32, padding: "4px 10px", borderRadius: 8, cursor: "pointer", background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)" }}>{t("app.inbox.dismiss")}</button>
        </div>
      )}
      <BucketTabs tabs={INBOX_TABS} active={tab} onChange={(b) => { setTab(b); setSteerOpen(null); }} t={t} rtl={rtl} />
      <div id="inbox-panel" role="tabpanel" aria-labelledby={`inbox-tab-${tab}`} tabIndex={0} style={{ marginTop: 16, display: "grid", gap: 20 }}>
        {tab === "needs_approval" && (
          <section aria-labelledby="inbox-approvals-h">
            <h2 id="inbox-approvals-h" style={{ fontWeight: 700, marginBottom: 8, color: "var(--color-on-surface)" }}>{t("app.inbox.approvalsTitle")}</h2>
            {groups.status === "loading" && <p role="status" style={muted}>{t("app.inbox.loading")}</p>}
            {groups.status === "error" && <ErrorBox t={t} title={t("app.inbox.approvalsErrorTitle")} body={t("app.inbox.errorBody")} onRetry={() => void loadGroups(null)} />}
            {groups.status === "ready" && (groups.data.length === 0 ? <EmptyBox text={t("app.inbox.approvalsEmpty")} /> : (
              <>
                <ApprovalGroups groups={groups.data} busyIds={busyApprovals} errorByApproval={approvalErrors} onDecide={decide} t={t} locale={locale} />
                {groups.cursor && moreBtn(groups.more, groups.moreError, () => void loadGroups(groups.cursor))}
              </>
            ))}
          </section>
        )}
        <section aria-label={t(`app.inbox.bucket.${tab}`)}>
          {tab === "needs_approval" && <h2 style={{ fontWeight: 700, marginBottom: 8, color: "var(--color-on-surface)" }}>{t("app.inbox.jobsTitle")}</h2>}
          {runs.status === "loading" && <p role="status" style={muted}>{t("app.inbox.loading")}</p>}
          {runs.status === "error" && <ErrorBox t={t} title={t("app.inbox.errorTitle")} body={t("app.inbox.errorBody")} onRetry={refresh} />}
          {runs.status === "ready" && (runs.data.length === 0 ? <EmptyBox text={t(EMPTY_KEY[tab])} /> : (
            <>
              <ul style={{ display: "grid", gap: 12, listStyle: "none", margin: 0, padding: 0 }}>
                {runs.data.map((run) => (
                  <RunRow key={run.id} run={run} t={t} locale={locale} busy={busyRuns.has(run.id)}
                    message={messages[run.id] ?? null} receipt={receipts[run.id] ?? null} steerOpen={steerOpen === run.id}
                    onAction={(a) => void runAction(run, a)} onSteerToggle={() => setSteerOpen(steerOpen === run.id ? null : run.id)}
                    onSteerSend={(text) => steer(run, text)} onReceiptToggle={() => void toggleReceipt(run)} />
                ))}
              </ul>
              {runs.cursor && moreBtn(runs.more, runs.moreError, () => void loadRuns(tab, runs.cursor))}
            </>
          ))}
        </section>
      </div>
    </div>
  );
}
