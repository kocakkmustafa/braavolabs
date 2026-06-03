"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";

export default function ApprovalsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listApprovals(token).then(setApprovals).catch(() => {});
  }, [token, hydrated]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div
        className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: "rgba(255,122,26,0.3)", borderTopColor: "#FF7A1A" }}
      />
    </div>
  );

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setLoading(true);
    setError(null);
    try {
      await api.decideApproval(token!, id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      decision === "APPROVED" ? sounds.success() : sounds.click();
    } catch (err) {
      console.error("Approval decision failed:", err);
      setError((err as Error).message);
      sounds.error();
    }
    setLoading(false);
  }

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
