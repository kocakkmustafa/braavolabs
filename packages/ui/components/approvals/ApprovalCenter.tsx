"use client";
/**
 * BRA-UX-05i — Onay ve güvenlik merkezi (bayrak `NEXT_PUBLIC_UX_APPROVALS`). Yalnız var olan uçlar: `GET /approvals` (düz liste) ve
 * `POST /approvals/:id/decide`. Toplu onay YOK: her onay tek tek karara bağlanır (ADR-0002 exact-action). Karar/yetki/yenileme kodu
 * eski sayfayla ortaktır (`useApprovalDecision`, `approvalsState`).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useApprovalDecision } from "../../lib/useApprovalDecision";
import { captureAuthSession, isAuthSessionCurrent, useAppStore } from "../../lib/store";
import { sounds } from "../../lib/sounds";
import { useLocalizedFailure } from "../../lib/localized-error";
import { useDisplayFormats } from "../../lib/useDisplayFormats";
import { formatDateTime, currentTimeZone } from "../../i18n/locales";
import {
  approvalsAlert, approvalsFailed, approvalsLoaded, approvalsRemove, approvalsView, initialApprovalsLoad, startApprovalsLoad,
  type ApprovalsLoad,
} from "../../lib/approvalsState";
import { isDangerous, parseAmount, toolName, type CenterApproval } from "../../lib/ux-approvals/approval";
import { ApprovalsEmpty, ApprovalsLoadError, ApprovalsLoading } from "./ApprovalsStatus";
import ApprovalSheet from "./ApprovalSheet";

const TYPES = ["SPEND", "INPUT", "HANDOFF", "EXTERNAL_CONTROL"] as const;
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const chip: React.CSSProperties = {
  fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "var(--color-surface-container-high)", color: "var(--color-on-surface-variant)",
};

export default function ApprovalCenter() {
  const t = useTranslations();
  const describeFailure = useLocalizedFailure();
  const displayFormat = useDisplayFormats();
  const locale = useLocale();
  const { token, hydrated } = useAuthGuard();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const [load, setLoad] = useState<ApprovalsLoad<CenterApproval>>(initialApprovalsLoad());
  const approvals: CenterApproval[] = load.status === "ready" ? load.data : [];
  const view = approvalsView(load);
  const alertInfo = approvalsAlert(load);
  const requestSeq = useRef(0);
  // busy ve hata onay kimliğine bağlıdır: başka onayın sheet'inde eski hata/devre dışı görünmez. id=null → sayfa düzeyi hata.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<{ id: string | null; text: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const noteRef = useRef<string | undefined>(undefined);
  const selectedRef = useRef<string | null>(null);
  const lastCommit = useRef<string | null>(null);
  const cn = (k: string, v?: Record<string, string | number>) => t(`app.approvalCenter.${k}`, v);

  const loadApprovals = useCallback(() => {
    if (!hydrated || !token) return;
    const seq = ++requestSeq.current;
    setLoad(startApprovalsLoad);
    api.listApprovals(token)
      .then((rows) => { if (seq === requestSeq.current) setLoad((prev) => approvalsLoaded<CenterApproval>(rows, prev)); })
      .catch(() => { if (seq === requestSeq.current) setLoad(approvalsFailed); });
  }, [token, hydrated]);
  useEffect(() => { loadApprovals(); }, [loadApprovals]);

  const closeSheet = useCallback(() => { restoreFocus.current = true; setSelectedId(null); }, []);
  // Kapanınca odak tetikleyiciye döner; satır gitmişse (karar verildi) başlığa.
  useEffect(() => {
    if (selectedId !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    const el = trigger.current;
    if (el && el.isConnected) el.focus();
    else heading.current?.focus();
  }, [selectedId]);

  const decide = useApprovalDecision({
    scopeKey: sessionRevision,
    captureSession: captureAuthSession,
    isSessionCurrent: (session) => !!session.token && isAuthSessionCurrent(session),
    request: async (id, decision) => {
      try {
        return { ran: true, result: await api.decideApproval(token!, id, decision, noteRef.current) };
      } catch (err) {
        // 409 (zaten karara bağlanmış) / 403 (yetki yok): dürüst mesaj + bayat satır kalmasın diye liste yeniden yüklenir.
        const status = (err as { status?: number } | null)?.status;
        if (status === 409 || status === 403) {
          setError({ id, text: cn(status === 409 ? "alreadyDecided" : "forbidden") });
          loadApprovals();
        } else setError({ id, text: describeFailure(err) });
        throw err;
      }
    },
    onBusy: (id, b) => {
      setBusyIds((prev) => { const n = new Set(prev); if (b) n.add(id); else n.delete(id); return n; });
      if (b) setError((e) => (e && e.id === id ? null : e));
    },
    // Önceki onayın gecikmiş sonucu, o sırada açılan YENİ sheet'i kapatmaz.
    onCommit: (id) => { lastCommit.current = id; setLoad((prev) => approvalsRemove(prev, id)); if (selectedRef.current === id) closeSheet(); },
    onSuccess: (decision) => {
      setNotice(cn(decision === "APPROVED" ? "approvedNotice" : "rejectedNotice"));
      if (decision === "APPROVED") sounds.success(); else sounds.click();
    },
    onBlocked: (reason) => {
      setError({ id: lastCommit.current, text: t("app.approvals.handoffIncomplete", { reason: reason ?? t("app.approvals.handoffNeedsAttention") }) });
      sounds.error();
    },
    onError: () => { sounds.error(); },
  });

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,122,26,0.3)", borderTopColor: "#FF7A1A" }} />
      </div>
    );
  }

  const selected = approvals.find((a) => a.id === selectedId) ?? null;
  selectedRef.current = selected ? selected.id : null;
  const when = (v?: string) => (v ? formatDateTime(v, locale, { timeZone: currentTimeZone(), dateStyle: "medium", timeStyle: "short" }) : null);
  const typeLabel = (type?: string | null) => cn(`type.${(TYPES as readonly string[]).includes(type ?? "") ? type : "other"}`);

  return (
    <div data-testid="approval-center" className="max-w-3xl mx-auto px-6 py-8">
      <header className="mb-6" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 ref={heading} tabIndex={-1} className="bv-headline text-on-surface">{cn("title")}</h1>
          <p className="bv-caption mt-1">{cn("subtitle")}</p>
          <p style={{ ...muted, marginTop: 4 }}>{cn("oneByOne")}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {approvals.length > 0 && <span className="bv-pill bv-pill-amber" style={{ fontSize: 11 }}>{cn("count", { count: approvals.length })}</span>}
          <Link href="/approvals?view=classic" style={{ ...muted, textDecoration: "underline" }}>{cn("classic")}</Link>
        </div>
      </header>

      {/* Ekran okuyucu: kova/liste değişimi ve karar sonucu duyurulur. */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="approval-live">
        {notice}{notice && view === "list" ? " " : ""}{view === "list" ? cn("live", { count: approvals.length }) : ""}
      </p>

      {error && error.id !== selected?.id && (
        <div role="alert" className="mb-5 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,77,77,0.08)", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(255,77,77,0.22)", color: "#FF8A8A" }}>
          {error.text}
        </div>
      )}

      {view === "loading" && <ApprovalsLoading t={t} />}
      {alertInfo.show && <ApprovalsLoadError t={t} inline={alertInfo.inline} busy={alertInfo.busy} onRetry={loadApprovals} />}

      {view === "loading" || view === "error" ? null : view === "empty" ? (
        <ApprovalsEmpty t={t} />
      ) : (
        <ul data-testid="approval-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {approvals.map((a) => {
            const tool = toolName(a);
            const danger = isDangerous(a);
            return (
              <li key={a.id}>
                <button
                  type="button" data-testid={`approval-row-${a.id}`} aria-label={cn("open", { title: a.description })} aria-haspopup="dialog"
                  onClick={(e) => { trigger.current = e.currentTarget; setSelectedId(a.id); }}
                  style={{
                    display: "grid", gap: 6, width: "100%", textAlign: "start", cursor: "pointer", padding: 16, borderRadius: 14, minHeight: 44,
                    background: "var(--color-surface-container)", color: "var(--color-on-surface)",
                    borderWidth: 1, borderStyle: "solid", borderColor: danger ? "rgba(255,77,77,0.4)" : "var(--color-surface-container-high)",
                  }}
                >
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={chip}>{typeLabel(a.type)}</span>
                    {tool && <span style={{ ...chip, fontFamily: "var(--font-mono, monospace)" }}>{tool}</span>}
                    {danger && <span style={{ ...chip, background: "rgba(255,77,77,0.12)", color: "#FF8A8A" }}>{cn("danger.tag")}</span>}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{a.description}</span>
                  <span style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline", ...muted }}>
                    {parseAmount(a.amountUsd) !== null && <span className="bv-numeric" style={{ fontSize: 18, color: "var(--bv-status-running)" }}>{displayFormat.usd(parseAmount(a.amountUsd) as number)}</span>}
                    {a.run?.pipeline?.company?.name && <span>{a.run.pipeline.company.name}</span>}
                    {a.createdAt && <span>{when(a.createdAt)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <ApprovalSheet
          key={selected.id} approval={selected} t={t} legacyT={t} locale={locale} usd={displayFormat.usd} when={when(selected.createdAt)}
          busy={busyIds.has(selected.id)} error={error && error.id === selected.id ? error.text : null}
          onDecide={(id, decision, note) => { noteRef.current = note; void decide(id, decision); }}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}
