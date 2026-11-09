"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { ApiRequestError } from "../../lib/api";
import {
  INBOX_TABS, actionErrorKey, mergeApprovalGroups, mergeById,
  type InboxApproval, type InboxApprovalGroup, type InboxRun,
} from "../../lib/inbox";
import type { InboxBucket } from "@ai-company-os/core";
import {
  ApprovalGroups, BucketTabs, EmptyBox, ErrorBox, RunRow, type ReceiptState, type T,
} from "../../components/inbox/InboxParts";

type Load<D> = { status: "loading" } | { status: "error" } | { status: "ready"; data: D; cursor: string | null; more: boolean; moreError: boolean };
const EMPTY_KEY: Record<InboxBucket, string> = {
  working: "app.inbox.emptyWorking", needs_approval: "app.inbox.emptyNeedsApproval",
  done: "app.inbox.emptyDone", stuck: "app.inbox.emptyStuck",
};

export default function InboxPage() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const rtl = locale === "ar";
  const { token, hydrated } = useAuthGuard();
  const [tab, setTab] = useState<InboxBucket>(INBOX_TABS[0]);
  const [runs, setRuns] = useState<Load<InboxRun[]>>({ status: "loading" });
  const [groups, setGroups] = useState<Load<InboxApprovalGroup[]>>({ status: "loading" });
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { kind: "ok" | "error"; text: string }>>({});
  const [steerOpen, setSteerOpen] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ReceiptState>>({});
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const runsSeq = useRef(0);
  const groupsSeq = useRef(0);

  const loadRuns = useCallback(async (bucket: InboxBucket, cursor: string | null) => {
    if (!token) return;
    const seq = ++runsSeq.current;
    if (!cursor) setRuns({ status: "loading" });
    else setRuns((p) => p.status === "ready" ? { ...p, more: true, moreError: false } : p);
    try {
      const page = await api.inboxRuns(token, bucket, cursor);
      if (seq !== runsSeq.current) return;
      setRuns((p) => ({
        status: "ready", cursor: page.nextCursor, more: false, moreError: false,
        data: cursor && p.status === "ready" ? mergeById(p.data, page.runs) : page.runs,
      }));
    } catch {
      if (seq !== runsSeq.current) return;
      setRuns((p) => cursor && p.status === "ready" ? { ...p, more: false, moreError: true } : { status: "error" });
    }
  }, [token]);

  const loadGroups = useCallback(async (cursor: string | null) => {
    if (!token) return;
    const seq = ++groupsSeq.current;
    if (!cursor) setGroups({ status: "loading" });
    else setGroups((p) => p.status === "ready" ? { ...p, more: true, moreError: false } : p);
    try {
      const page = await api.inboxApprovalGroups(token, cursor);
      if (seq !== groupsSeq.current) return;
      setGroups((p) => ({
        status: "ready", cursor: page.nextCursor, more: false, moreError: false,
        data: cursor && p.status === "ready" ? mergeApprovalGroups(p.data, page.groups) : page.groups,
      }));
    } catch {
      if (seq !== groupsSeq.current) return;
      setGroups((p) => cursor && p.status === "ready" ? { ...p, more: false, moreError: true } : { status: "error" });
    }
  }, [token]);

  useEffect(() => { if (hydrated && token) void loadRuns(tab, null); }, [hydrated, token, tab, loadRuns]);
  useEffect(() => { if (hydrated && token && tab === "needs_approval") void loadGroups(null); }, [hydrated, token, tab, loadGroups]);

  const refresh = () => { void loadRuns(tab, null); if (tab === "needs_approval") void loadGroups(null); };

  const setMsg = (id: string, kind: "ok" | "error", text: string) => setMessages((m) => ({ ...m, [id]: { kind, text } }));

  const runAction = async (run: InboxRun, action: "resume" | "retry" | "pause" | "stop") => {
    if (!token) return;
    setBusyRun(run.id);
    try {
      await api.runAction(token, run.id, action);
      setMsg(run.id, "ok", t("app.inbox.actionOk"));
      void loadRuns(tab, null);
    } catch (err) { setMsg(run.id, "error", t(actionErrorKey(err))); }
    finally { setBusyRun(null); }
  };

  const steer = async (run: InboxRun, text: string) => {
    if (!token) return;
    setBusyRun(run.id);
    try {
      await api.steerRun(token, run.id, text);
      setMsg(run.id, "ok", t("app.inbox.steerSent"));
      setSteerOpen(null);
    } catch (err) { setMsg(run.id, "error", t(actionErrorKey(err))); }
    finally { setBusyRun(null); }
  };

  const toggleReceipt = async (run: InboxRun) => {
    if (!token) return;
    if (receipts[run.id]) { setReceipts(({ [run.id]: _, ...rest }) => rest); return; }
    setReceipts((r) => ({ ...r, [run.id]: { status: "loading" } }));
    try {
      const receipt = await api.runReceipt(token, run.id);
      setReceipts((r) => r[run.id] ? { ...r, [run.id]: { status: "ready", receipt } } : r);
    } catch (err) {
      const none = err instanceof ApiRequestError && err.status === 404;
      setReceipts((r) => r[run.id] ? { ...r, [run.id]: { status: none ? "none" : "error" } } : r);
    }
  };

  const decide = async (a: InboxApproval, decision: "APPROVED" | "REJECTED") => {
    if (!token) return;
    setBusyApproval(a.id);
    setApprovalErrors(({ [a.id]: _, ...rest }) => rest);
    try {
      await api.decideApproval(token, a.id, decision);
      void loadGroups(null);
      void loadRuns(tab, null);
    } catch (err) {
      const key = err instanceof ApiRequestError && err.status === 409 ? "app.inbox.approvalConflict" : "app.inbox.approvalFailed";
      setApprovalErrors((m) => ({ ...m, [a.id]: t(key) }));
    } finally { setBusyApproval(null); }
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
      <BucketTabs tabs={INBOX_TABS} active={tab} onChange={(b) => { setTab(b); setSteerOpen(null); }} t={t} rtl={rtl} />
      <div id="inbox-panel" role="tabpanel" aria-labelledby={`inbox-tab-${tab}`} tabIndex={0} style={{ marginTop: 16, display: "grid", gap: 20 }}>
        {tab === "needs_approval" && (
          <section aria-labelledby="inbox-approvals-h">
            <h2 id="inbox-approvals-h" style={{ fontWeight: 700, marginBottom: 8, color: "var(--color-on-surface)" }}>{t("app.inbox.approvalsTitle")}</h2>
            {groups.status === "loading" && <p role="status" style={muted}>{t("app.inbox.loading")}</p>}
            {groups.status === "error" && <ErrorBox t={t} title={t("app.inbox.approvalsErrorTitle")} body={t("app.inbox.errorBody")} onRetry={() => void loadGroups(null)} />}
            {groups.status === "ready" && (groups.data.length === 0 ? <EmptyBox text={t("app.inbox.approvalsEmpty")} /> : (
              <>
                <ApprovalGroups groups={groups.data} busyId={busyApproval} errorByApproval={approvalErrors} onDecide={decide} t={t} locale={locale} />
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
                  <RunRow key={run.id} run={run} t={t} locale={locale} busy={busyRun === run.id}
                    message={messages[run.id] ?? null} receipt={receipts[run.id] ?? null} steerOpen={steerOpen === run.id}
                    onAction={(a) => void runAction(run, a)} onSteerToggle={() => setSteerOpen(steerOpen === run.id ? null : run.id)}
                    onSteerSend={(text) => void steer(run, text)} onReceiptToggle={() => void toggleReceipt(run)} />
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
