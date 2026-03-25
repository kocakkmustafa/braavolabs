"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

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
  const token = useAppStore((s) => s.token);
  const router = useRouter();
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }
    api.listCompanies(token).then((list) => {
      setCompanies(list);
      if (list.length > 0) setSelectedCompany(list[0].id);
    }).catch(() => {});
  }, [token, router]);

  useEffect(() => {
    if (!token || !selectedCompany) return;
    setLoading(true);
    api.listDrafts(token, selectedCompany)
      .then(setDrafts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, selectedCompany]);

  if (!token) return null;

  async function updateStatus(id: string, status: string) {
    try {
      await api.updateDraft(token!, id, { status });
      setDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status } : d))
      );
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }} className="animate-fade-in">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>Drafts</h1>
          <p style={{ fontSize: 14, color: "#859399", marginTop: 4 }}>Content created by your AI agents</p>
        </div>
        <select
          value={selectedCompany}
          onChange={(e) => setSelectedCompany(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#bbc9cf",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 13,
            outline: "none",
            cursor: "pointer",
          }}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id} style={{ background: "#1a1d27" }}>{c.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-shimmer"
              style={{ height: 96, borderRadius: 16, background: "rgba(255,255,255,0.04)" }}
            />
          ))}
        </div>
      ) : drafts.length === 0 ? (
        <div
          style={{
            background: "rgba(29,32,38,0.8)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 16,
            padding: "64px 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 16,
              background: "rgba(109,17,173,0.12)",
              border: "1px solid rgba(109,17,173,0.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}
          >
            <svg width={24} height={24} fill="none" viewBox="0 0 24 24" stroke="#e0b6ff" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </div>
          <p style={{ fontWeight: 600, color: "#bbc9cf", margin: 0 }}>No drafts yet</p>
          <p style={{ fontSize: 13, color: "#859399", marginTop: 4 }}>Drafts will appear here when agents create content.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {drafts.map((d) => (
            <div
              key={d.id}
              style={{
                background: "rgba(29,32,38,0.8)",
                backdropFilter: "blur(24px)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 16,
                padding: "20px 24px",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <h3 style={{ fontWeight: 600, color: "#e1e2eb", margin: 0, fontSize: 14 }}>{d.title}</h3>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontWeight: 600,
                        ...(STATUS_STYLES[d.status] ?? DEFAULT_STATUS),
                      }}
                    >
                      {d.status}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 6,
                        fontWeight: 500,
                        background: "rgba(109,17,173,0.1)",
                        color: "#e0b6ff",
                        border: "1px solid rgba(109,17,173,0.2)",
                      }}
                    >
                      {TYPE_LABELS[d.type] ?? d.type}
                    </span>
                  </div>
                  {d.channel && (
                    <p style={{ fontSize: 13, color: "#859399", margin: "0 0 6px" }}>Channel: {d.channel}</p>
                  )}
                  {d.content && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 13,
                        color: "#bbc9cf",
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        maxHeight: 128,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {typeof d.content === "string" ? d.content : JSON.stringify(d.content, null, 2)}
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 8, fontSize: 11, color: "#3c494e" }}>
                    <span>Created: {new Date(d.createdAt).toLocaleString()}</span>
                    {d.scheduledAt && (
                      <span>Scheduled: {new Date(d.scheduledAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  {d.status === "DRAFT" && (
                    <button
                      onClick={() => updateStatus(d.id, "APPROVED")}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#fff",
                        background: "#34d399",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Approve
                    </button>
                  )}
                  {(d.status === "DRAFT" || d.status === "REVIEW") && (
                    <button
                      onClick={() => updateStatus(d.id, "REJECTED")}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#f87171",
                        background: "rgba(239,68,68,0.1)",
                        border: "1px solid rgba(239,68,68,0.2)",
                        cursor: "pointer",
                      }}
                    >
                      Reject
                    </button>
                  )}
                  {d.status === "APPROVED" && (
                    <button
                      onClick={() => updateStatus(d.id, "PUBLISHED")}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#a4e6ff",
                        background: "rgba(0,209,255,0.1)",
                        border: "1px solid rgba(0,209,255,0.2)",
                        cursor: "pointer",
                      }}
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
