"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";
import { draftActions, previewDraftContent } from "../../lib/draftWorkflow";

const STATUS_STYLES: Record<string, { background: string; color: string; border: string }> = {
  PENDING:   { background: "rgba(255,122,26,0.1)",  color: "#FF7A1A", border: "1px solid rgba(255,122,26,0.2)" },
  APPROVED:  { background: "rgba(59,130,246,0.1)",  color: "#60A5FA", border: "1px solid rgba(59,130,246,0.2)" },
  PUBLISHED: { background: "rgba(59,130,246,0.1)",  color: "#7DD3FC", border: "1px solid rgba(59,130,246,0.2)" },
  REJECTED:  { background: "rgba(255,77,77,0.1)",   color: "#FF4D4D", border: "1px solid rgba(255,77,77,0.2)" },
  ARCHIVED:  { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" },
};

const DEFAULT_STATUS = { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

// Localised at render — DB enum values map to i18n keys.
const TYPE_KEY: Record<string, string> = {
  SOCIAL_POST: "typeSocial",
  EMAIL: "typeEmail",
  BLOG_POST: "typeBlog",
  AD_COPY: "typeAd",
  VIDEO_SCRIPT: "typeVideo",
};
const STATUS_KEY: Record<string, string> = {
  PENDING: "statusPending",
  APPROVED: "statusApproved",
  PUBLISHED: "statusPublished",
  REJECTED: "statusRejected",
  ARCHIVED: "statusArchived",
};

export default function DraftsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const decisionInFlight = useRef(false);

  useEffect(() => {
    if (!hydrated || !token) return;
    let cancelled = false;
    setCompanies([]);
    setSelectedCompany("");
    setDrafts([]);
    setSelectedDraft(null);
    api.listCompanies(token).then((list) => {
      if (cancelled) return;
      setCompanies(list);
      if (list.length > 0) setSelectedCompany(list[0].id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [token, hydrated]);

  useEffect(() => {
    if (!token || !selectedCompany) return;
    let cancelled = false;
    setLoading(true);
    setDrafts([]);
    setSelectedDraft(null);
    api.listDrafts(token, selectedCompany)
      .then((list) => {
        if (cancelled) return;
        setDrafts(list);
        if (list.length > 0) setSelectedDraft(list[0].id);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, selectedCompany]);

  const [error, setError] = useState<string | null>(null);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }} />
    </div>
  );

  async function rejectDraft(id: string) {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    setActionPending(true);
    setError(null);
    try {
      const updatedDraft = await api.updateDraft(token!, id, { status: "REJECTED" });
      setDrafts((prev) => {
        const updated = prev.map((d) => (d.id === id ? { ...d, ...updatedDraft } : d));
        const remaining = updated.filter((d) => d.status !== "REJECTED");
        if (selectedDraft === id && remaining.length > 0) {
          setSelectedDraft(remaining[0].id);
        }
        return updated;
      });
      sounds.click();
    } catch (err) {
      console.error("Draft status update failed:", err);
      setError((err as Error).message);
      sounds.error();
    } finally {
      decisionInFlight.current = false;
      setActionPending(false);
    }
  }

  async function approveDraft(id: string, send: boolean) {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    setActionPending(true);
    setError(null);
    try {
      const updatedDraft = await api.approveDraft(token!, id, send);
      setDrafts((prev) => prev.map((d) => d.id === id ? { ...d, ...updatedDraft } : d));
      if (send && updatedDraft.status !== "PUBLISHED") {
        setError(t("app.drafts.sendNotCompleted"));
        sounds.error();
      } else {
        sounds.success();
      }
    } catch (err) {
      console.error("Draft approval failed:", err);
      setError((err as Error).message);
      sounds.error();
    } finally {
      decisionInFlight.current = false;
      setActionPending(false);
    }
  }

  const activeDraft = drafts.find((d) => d.id === selectedDraft) ?? null;
  const pendingDrafts = drafts.filter((d) => d.status === "PENDING");
  const selectedCompanyRecord = companies.find((company) => company.id === selectedCompany);
  const actions = draftActions(activeDraft, selectedCompanyRecord);
  const preview = activeDraft ? previewDraftContent(activeDraft.content) : null;

  return (
    <div className="animate-fade-in" style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Page head */}
      <div className="bv-page-head" style={{ marginBottom: 24 }}>
        <div>
          <div className="bv-micro" style={{ marginBottom: 4, color: "var(--color-outline)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 12, marginRight: 4 }}>edit_note</span>
            Content review
          </div>
          <h1 className="bv-headline gradient-text" style={{ margin: 0 }}>{t("app.drafts.title")}</h1>
          <p className="bv-caption" style={{ marginTop: 4 }}>{t("app.drafts.subtitle")}</p>
        </div>
        <div className="bv-page-head-actions">
          {/* Company filter */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="company-filter" className="bv-caption" style={{ whiteSpace: "nowrap" }}>
              {t("app.drafts.filterLabel")}
            </label>
            <select
              id="company-filter"
              value={selectedCompany}
              onChange={(e) => { sounds.click(); setSelectedCompany(e.target.value); }}
              className="bv-btn bv-btn-ghost bv-btn-sm"
              style={{ cursor: "pointer", paddingLeft: 10, paddingRight: 10 }}
            >
              {companies.length === 0 && (
                <option value="" disabled style={{ background: "#06070A" }}>{t("app.drafts.noCompanies")}</option>
              )}
              {companies.map((c) => (
                <option key={c.id} value={c.id} style={{ background: "#06070A" }}>{c.name}</option>
              ))}
            </select>
          </div>
          {pendingDrafts.length > 0 && (
            <span className="bv-pill bv-pill-amber">
              {t("app.drafts.pendingCount", { count: pendingDrafts.length })}
            </span>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 12,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(255,77,77,0.08)",
            border: "1px solid rgba(255,77,77,0.22)",
            color: "#FF4D4D",
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>error_outline</span>
          {error}
        </div>
      )}

      {loading ? (
        /* Skeleton */
        <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-shimmer bv-glass" style={{ height: 96 }} />
            ))}
          </div>
          <div className="animate-shimmer bv-glass" style={{ height: 320 }} />
        </div>
      ) : drafts.length === 0 ? (
        /* Empty state */
        <div className="bv-glass" style={{ padding: "64px 32px", textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
              background: "rgba(59,130,246,0.08)",
              border: "1px solid rgba(59,130,246,0.18)",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 24, color: "#60A5FA" }}>edit_note</span>
          </div>
          <p className="bv-title" style={{ marginBottom: 6 }}>{t("app.drafts.emptyTitle")}</p>
          <p className="bv-caption">{t("app.drafts.emptyBody")}</p>
        </div>
      ) : (
        /* Two-column split: list ← → preview */
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "340px 1fr",
            gap: 20,
            alignItems: "start",
          }}
        >
          {/* Left: draft list */}
          <div className="bv-stagger" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts.map((d) => {
              const isSel = d.id === selectedDraft;
              return (
                <button
                  key={d.id}
                  onClick={() => { sounds.click(); setSelectedDraft(d.id); }}
                  className="bv-glass"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "16px 18px",
                    cursor: "pointer",
                    border: isSel
                      ? "1px solid rgba(59,130,246,0.55)"
                      : "1px solid var(--bv-glass-border)",
                    boxShadow: isSel
                      ? "0 0 0 1px rgba(59,130,246,0.18), 0 0 28px -10px rgba(59,130,246,0.35)"
                      : "none",
                    borderRadius: 14,
                    background: isSel
                      ? "rgba(59,130,246,0.06)"
                      : "var(--bv-glass-bg)",
                    transition: "all 200ms var(--bv-ease-out)",
                  }}
                >
                  <div className="bv-title" style={{ fontSize: 14 }}>{d.title}</div>
                  <div
                    className="bv-mono"
                    style={{
                      marginTop: 5,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: "var(--color-outline)",
                    }}
                  >
                    <span
                      className="bv-dot"
                      style={{
                        background:
                          d.status === "PENDING"
                            ? "var(--bv-status-running)"
                            : d.status === "APPROVED" || d.status === "PUBLISHED"
                            ? "var(--bv-status-completed)"
                            : "var(--bv-status-failed)",
                      }}
                    />
                    {d.channel ? d.channel : (d.type ?? "Draft")}
                  </div>
                  <div style={{ marginTop: 9, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span
                      className="bv-pill bv-pill-muted"
                      style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}
                    >
                      {TYPE_KEY[d.type] ? t(`app.drafts.${TYPE_KEY[d.type]}`) : (d.type ?? "Draft")}
                    </span>
                    <span
                      className="bv-pill"
                      style={{ ...(STATUS_STYLES[d.status] ?? DEFAULT_STATUS), textTransform: "none", letterSpacing: 0, fontWeight: 500 }}
                    >
                      {STATUS_KEY[d.status] ? t(`app.drafts.${STATUS_KEY[d.status]}`) : d.status}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: preview panel — sticky */}
          <div
            className="bv-glass"
            style={{ position: "sticky", top: 84, borderRadius: 16, overflow: "hidden" }}
          >
            {activeDraft ? (
              <>
                {/* Preview header */}
                <div
                  style={{
                    padding: "18px 22px",
                    borderBottom: "1px solid var(--bv-glass-border)",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="bv-title" style={{ fontSize: 16 }}>{activeDraft.title}</div>
                    <div className="bv-mono" style={{ marginTop: 4, color: "var(--color-outline)" }}>
                      {activeDraft.channel ?? activeDraft.type ?? "Draft"}
                    </div>
                    {activeDraft.scheduledAt && (
                      <div className="bv-mono" style={{ marginTop: 3, color: "var(--color-outline)" }}>
                        {t("app.drafts.scheduledLabel")} {new Date(activeDraft.scheduledAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <span
                    className="bv-pill"
                    style={{ ...(STATUS_STYLES[activeDraft.status] ?? DEFAULT_STATUS), textTransform: "none", letterSpacing: 0, fontWeight: 500, flexShrink: 0 }}
                  >
                    {TYPE_KEY[activeDraft.type] ? t(`app.drafts.${TYPE_KEY[activeDraft.type]}`) : (activeDraft.type ?? "Draft")}
                  </span>
                </div>

                {/* Content body */}
                <div
                  style={{
                    padding: "18px 22px",
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: "var(--color-on-surface)",
                    maxHeight: "46vh",
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {preview ?? <span style={{ color: "var(--color-outline)", fontStyle: "italic" }}>{t("app.drafts.noPreview")}</span>}
                </div>

                {/* Created timestamp */}
                <div
                  className="bv-mono"
                  style={{
                    padding: "0 22px 12px",
                    color: "var(--color-outline)",
                    fontSize: 11,
                  }}
                >
                  {t("app.drafts.createdLabel")} {new Date(activeDraft.createdAt).toLocaleString()}
                </div>

                {/* Action footer */}
                <div
                  style={{
                    padding: "14px 22px",
                    borderTop: "1px solid var(--bv-glass-border)",
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  {actions.approve && (
                    <button
                      className="bv-btn bv-btn-primary bv-btn-sm"
                      disabled={actionPending}
                      onClick={() => approveDraft(activeDraft.id, false)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check_circle</span>
                      {t("app.drafts.approve")}
                    </button>
                  )}
                  {actions.send && (
                    <button
                      className="bv-btn bv-btn-primary bv-btn-sm"
                      disabled={actionPending}
                      onClick={() => approveDraft(activeDraft.id, true)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>send</span>
                      {t("app.drafts.approveAndSend")}
                    </button>
                  )}
                  {activeDraft.status === "PENDING" && activeDraft.companyId === selectedCompanyRecord?.id && selectedCompanyRecord?.status !== "ACTIVE" && (
                    <span className="bv-caption">{t("app.drafts.inactiveCompany")}</span>
                  )}
                  {actions.reject && (
                    <button
                      className="bv-btn bv-btn-danger bv-btn-sm"
                      disabled={actionPending}
                      onClick={() => rejectDraft(activeDraft.id)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>cancel</span>
                      {t("app.drafts.reject")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: "50px 32px", textAlign: "center" }}>
                <p className="bv-caption">{t("app.drafts.selectPreview")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
