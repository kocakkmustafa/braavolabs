"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";

const STATUS_STYLES: Record<string, { background: string; color: string; border: string }> = {
  DRAFT:     { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" },
  REVIEW:    { background: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
  APPROVED:  { background: "rgba(52,211,153,0.1)",  color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" },
  PUBLISHED: { background: "rgba(0,209,255,0.1)",   color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.2)" },
  REJECTED:  { background: "rgba(239,68,68,0.1)",   color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
};

const DEFAULT_STATUS = { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

const TYPE_LABELS: Record<string, string> = {
  SOCIAL_POST: "Social Post",
  EMAIL: "Email",
  BLOG_POST: "Blog Post",
  AD_COPY: "Ad Copy",
  VIDEO_SCRIPT: "Video Script",
};

export default function DraftsPage() {
  const { token, hydrated } = useAuthGuard();
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listCompanies(token).then((list) => {
      setCompanies(list);
      if (list.length > 0) setSelectedCompany(list[0].id);
    }).catch(() => {});
  }, [token, hydrated]);

  useEffect(() => {
    if (!token || !selectedCompany) return;
    setLoading(true);
    api.listDrafts(token, selectedCompany)
      .then(setDrafts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, selectedCompany]);

  const [error, setError] = useState<string | null>(null);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  async function updateStatus(id: string, status: string) {
    setError(null);
    try {
      await api.updateDraft(token!, id, { status });
      setDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status } : d))
      );
      status === "APPROVED" || status === "PUBLISHED" ? sounds.success() : sounds.click();
    } catch (err) {
      console.error("Draft status update failed:", err);
      setError((err as Error).message);
      sounds.error();
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline gradient-text">Drafts</h1>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>Content created by your AI agents</p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="company-filter" className="text-xs font-medium" style={{ color: "#859399", whiteSpace: "nowrap" }}>Filter by company</label>
          <select
            id="company-filter"
            value={selectedCompany}
            onChange={(e) => { sounds.click(); setSelectedCompany(e.target.value); }}
            className="rounded-xl px-3 py-2 text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
          >
            {companies.length === 0 && (
              <option value="" disabled style={{ background: "#0a0d14" }}>All Companies</option>
            )}
            {companies.map((c) => (
              <option key={c.id} value={c.id} style={{ background: "#0a0d14" }}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-shimmer rounded-2xl" style={{ height: 96, background: "rgba(255,255,255,0.04)" }} />
          ))}
        </div>
      ) : drafts.length === 0 ? (
        <div className="glass-card rounded-2xl py-16 px-6 text-center">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(109,17,173,0.12)", border: "1px solid rgba(109,17,173,0.25)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 24, color: "#e0b6ff" }}>edit_note</span>
          </div>
          <p className="font-semibold" style={{ color: "#bbc9cf" }}>No drafts yet</p>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>Drafts will appear here when agents create content.</p>
        </div>
      ) : (
        <div className="space-y-4 stagger-children">
          {drafts.map((d) => (
            <div key={d.id} className="glass-card rounded-2xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <h3 className="font-semibold text-sm" style={{ color: "#e1e2eb" }}>{d.title}</h3>
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                      style={STATUS_STYLES[d.status] ?? DEFAULT_STATUS}
                    >
                      {d.status}
                    </span>
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-md font-medium"
                      style={{ background: "rgba(109,17,173,0.1)", color: "#e0b6ff", border: "1px solid rgba(109,17,173,0.2)" }}
                    >
                      {TYPE_LABELS[d.type] ?? d.type}
                    </span>
                  </div>
                  {d.channel && (
                    <p className="text-sm mb-1.5" style={{ color: "#859399" }}>Channel: {d.channel}</p>
                  )}
                  {d.content && (
                    <div
                      className="mt-2 text-sm rounded-xl p-3"
                      style={{
                        color: "#bbc9cf",
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        maxHeight: 128,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {typeof d.content === "string" ? d.content : JSON.stringify(d.content, null, 2)}
                    </div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-[11px]" style={{ color: "#3c494e" }}>
                    <span>Created: {new Date(d.createdAt).toLocaleString()}</span>
                    {d.scheduledAt && <span>Scheduled: {new Date(d.scheduledAt).toLocaleString()}</span>}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {d.status === "DRAFT" && (
                    <button
                      onClick={() => updateStatus(d.id, "APPROVED")}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:brightness-110"
                      style={{ background: "#34d399" }}
                    >
                      Approve
                    </button>
                  )}
                  {(d.status === "DRAFT" || d.status === "REVIEW") && (
                    <button
                      onClick={() => updateStatus(d.id, "REJECTED")}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110"
                      style={{ color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
                    >
                      Reject
                    </button>
                  )}
                  {d.status === "APPROVED" && (
                    <button
                      onClick={() => updateStatus(d.id, "PUBLISHED")}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110"
                      style={{ color: "#a4e6ff", background: "rgba(0,209,255,0.1)", border: "1px solid rgba(0,209,255,0.2)" }}
                    >
                      Publish
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
