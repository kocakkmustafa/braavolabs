"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useApprovalDecision } from "../../lib/useApprovalDecision";
import { captureAuthSession, isAuthSessionCurrent, useAppStore } from "../../lib/store";
import { sounds } from "../../lib/sounds";
import BrandMotion from "../../components/BrandMotion";
import { approvalMotion } from "../../lib/brandMotion";

export default function ApprovalsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listApprovals(token).then(setApprovals).catch(() => {});
  }, [token, hydrated]);

  const decide = useApprovalDecision({
    scopeKey: sessionRevision,
    captureSession: captureAuthSession,
    isSessionCurrent: (session) => !!session.token && isAuthSessionCurrent(session),
    request: async (id, decision) => ({ ran: true, result: await api.decideApproval(token!, id, decision) }),
    onBusy: (_id, busy) => { setLoading(busy); if (busy) setError(null); },
    onCommit: (id) => setApprovals((prev) => prev.filter((a) => a.id !== id)),
    onSuccess: (decision) => decision === "APPROVED" ? sounds.success() : sounds.click(),
    onBlocked: (reason) => {
      setError(t("app.approvals.handoffIncomplete", { reason: reason ?? t("app.approvals.handoffNeedsAttention") }));
      sounds.error();
    },
    onError: (err) => { setError((err as Error).message); sounds.error(); },
  });

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div
        className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: "rgba(255,122,26,0.3)", borderTopColor: "#FF7A1A" }}
      />
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 animate-fade-in">

      {/* Page head */}
      <div className="bv-page-head mb-8">
        <div>
          <p className="bv-micro mb-1" style={{ color: "var(--bv-status-running)" }}>
            Spend queue
          </p>
          <h1 className="bv-headline text-on-surface">
            {t("app.approvals.title")}
          </h1>
          <p className="bv-caption mt-1">{t("app.approvals.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <BrandMotion state={approvalMotion(approvals.length, error)} size={48} />
          {approvals.length > 0 && (
            <div
              className="bv-pill bv-pill-amber"
              style={{ fontSize: 11 }}
            >
              <span
                className="bv-dot bv-running bv-ping"
                style={{ width: 6, height: 6 }}
              />
              {approvals.length} pending
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
          style={{
            background: "rgba(255,77,77,0.08)",
            border: "1px solid rgba(255,77,77,0.22)",
            color: "#FF8A8A",
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#FF4D4D" }}>
            error
          </span>
          {error}
        </div>
      )}

      {/* Empty state */}
      {approvals.length === 0 ? (
        <div className="bv-glass rounded-2xl py-16 px-6 text-center bv-rise">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{
              background: "rgba(59,130,246,0.08)",
              border: "1px solid rgba(59,130,246,0.18)",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 26, color: "#60A5FA" }}
            >
              check_circle
            </span>
          </div>
          <p className="bv-title mb-1">{t("app.approvals.emptyTitle")}</p>
          <p className="bv-caption">{t("app.approvals.emptyBody")}</p>
        </div>
      ) : (
        /* Approval queue */
        <div className="bv-stagger" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {approvals.map((a) => (
            <div
              key={a.id}
              className="bv-glass bv-pulse-glow"
              style={{
                padding: "22px",
                borderColor: "rgba(255,122,26,0.35)",
                background: "linear-gradient(135deg, rgba(255,122,26,0.06) 0%, transparent 60%)",
              }}
            >
              {/* Top row: agent who + urgent tag */}
              <div className="flex items-center gap-2 mb-3">
                <span className="bv-dot bv-running bv-ping" />
                <span
                  className="bv-mono"
                  style={{ color: "var(--bv-status-running)", fontSize: 12 }}
                >
                  {a.run?.pipeline?.company?.name ?? t("app.approvals.unknownCompany")}
                </span>
                <span
                  className="bv-pill bv-pill-amber ml-auto"
                  style={{ fontSize: 10 }}
                >
                  urgent
                </span>
              </div>

              {/* What / why */}
              <p
                className="bv-title mb-1"
                style={{ fontSize: 17 }}
              >
                {a.description}
              </p>

              {/* Details row: amount + run link */}
              <div className="flex items-baseline gap-4 my-3">
                {a.amountUsd && (
                  <span
                    className="bv-numeric"
                    style={{
                      fontSize: 32,
                      color: "var(--bv-status-running)",
                      lineHeight: 1,
                    }}
                  >
                    ${Number(a.amountUsd).toFixed(2)}
                  </span>
                )}
                <a
                  href={`/runs/${a.runId}`}
                  className="bv-mono"
                  style={{
                    color: "#60A5FA",
                    textDecoration: "none",
                    fontSize: 12,
                  }}
                >
                  ↗ {a.runId?.slice(0, 8)}
                </a>
                <span className="bv-caption" style={{ marginLeft: "auto" }}>
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </div>

              {/* Draft artifact (D5) — review the actual generated content before
                  deciding. Only present for content approvals; spend approvals
                  (amountUsd above) render without it. */}
              {a.artifact && <ArtifactCard artifact={a.artifact} t={t} />}

              {/* Divider */}
              <div className="bv-divider mb-4" />

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => decide(a.id, "APPROVED")}
                  disabled={loading}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    check
                  </span>
                  {t("app.approvals.approve")}
                  {a.amountUsd && (
                    <span style={{ opacity: 0.85 }}>
                      &nbsp;${Number(a.amountUsd).toFixed(2)}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => decide(a.id, "REJECTED")}
                  disabled={loading}
                  className="bv-btn bv-btn-danger bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    close
                  </span>
                  {t("app.approvals.reject")}
                </button>
                <span className="bv-micro ml-auto">
                  {t("app.approvals.runLabel")} {a.runId?.slice(0, 8)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Draft-artifact card (D5) ──────────────────────────────────────────────
 * Lindy's signature move: when an approval is about generated CONTENT, show the
 * real draft — subject bold, body in a scrollable mono block — so the operator
 * reviews the work, not just a one-line summary, before approving/rejecting. */
interface ApprovalArtifact {
  kind: "email" | "social_post" | "message" | "content";
  title?: string;
  body: string;
  source: "draft" | "action";
}

const ARTIFACT_ICON: Record<ApprovalArtifact["kind"], string> = {
  email: "mail",
  social_post: "campaign",
  message: "forum",
  content: "draft",
};

function ArtifactCard({
  artifact,
  t,
}: {
  artifact: ApprovalArtifact;
  t: ReturnType<typeof useTranslations>;
}) {
  const kindLabel = t(`app.approvals.artifactKind.${artifact.kind}`);
  return (
    <div
      className="my-4 rounded-xl overflow-hidden"
      style={{
        border: "1px solid rgba(96,165,250,0.18)",
        background: "rgba(59,130,246,0.04)",
      }}
    >
      {/* Header: kind + "AI-generated" honesty label */}
      <div
        className="flex items-center gap-2 px-3.5 py-2.5"
        style={{ borderBottom: "1px solid rgba(96,165,250,0.12)" }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#60A5FA" }}>
          {ARTIFACT_ICON[artifact.kind]}
        </span>
        <span className="bv-micro" style={{ color: "#60A5FA", letterSpacing: 0 }}>
          {kindLabel}
        </span>
        <span
          className="bv-pill bv-pill-muted ml-auto"
          style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em" }}
        >
          {t("app.approvals.artifactAiLabel")}
        </span>
      </div>

      {/* Subject / title — bold */}
      {artifact.title && (
        <div
          className="px-3.5 pt-3"
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--color-on-surface)",
          }}
        >
          {artifact.title}
        </div>
      )}

      {/* Body — scrollable, monospace, preserves line breaks */}
      <pre
        className="bv-mono px-3.5 py-3 m-0"
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--color-on-surface-variant)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 260,
          overflowY: "auto",
        }}
      >
        {artifact.body}
      </pre>
    </div>
  );
}
