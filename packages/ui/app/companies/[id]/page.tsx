"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, apiFetch } from "../../../lib/api";
import { useAppStore } from "../../../lib/store";

type Tab = "overview" | "pipelines" | "agents" | "runs" | "contacts" | "memory";

export default function CompanyDetailPage() {
  const params = useParams();
  const token = useAppStore((s) => s.token);
  const [company, setCompany] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [runs, setRuns] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !params.id) return;
    api.getCompany(token, params.id as string).then(setCompany).catch((e) => setError(e.message));
  }, [token, params.id]);

  useEffect(() => {
    if (!token || !company || tab !== "runs") return;
    apiFetch<any[]>(`/dashboard/runs?companyId=${company.id}&limit=50`, { token })
      .then((data) => setRuns(Array.isArray(data) ? data : (data as any).runs ?? []))
      .catch(() => {});
  }, [token, company, tab]);

  if (!token) return <p style={{ color: "#859399", padding: 32 }}>Please log in first.</p>;
  if (error) return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", padding: 16, borderRadius: 12, fontSize: 14 }}>{error}</div>
    </div>
  );
  if (!company) return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }}>
      <div className="animate-shimmer" style={{ height: 32, width: 192, borderRadius: 8, background: "rgba(255,255,255,0.06)" }} />
    </div>
  );

  const statusStyles: Record<string, { dotColor: string; bg: string; color: string; border: string }> = {
    ACTIVE:   { dotColor: "#34d399", bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" },
    PAUSED:   { dotColor: "#fbbf24", bg: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
    ARCHIVED: { dotColor: "#f87171", bg: "rgba(239,68,68,0.1)",   color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
  };
  const s = statusStyles[company.status] ?? { dotColor: "#859399", bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "agents", label: "Agents", count: company.agents?.length },
    { key: "pipelines", label: "Pipelines", count: company.pipelines?.length },
    { key: "runs", label: "Runs" },
    { key: "contacts", label: "CRM" },
    { key: "memory", label: "Memory" },
  ];

  const runStatusStyles: Record<string, { bg: string; color: string; border: string }> = {
    COMPLETED: { bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" },
    FAILED:    { bg: "rgba(239,68,68,0.1)",   color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
    RUNNING:   { bg: "rgba(0,209,255,0.1)",   color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.2)" },
    PAUSED:    { bg: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
    CANCELLED: { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" },
  };
  const defaultRunStatus = { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

  return (
    <div style={{ maxWidth: 1152, margin: "0 auto", padding: "32px 24px" }} className="animate-fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 22,
              boxShadow: "0 8px 24px rgba(0,209,255,0.2)",
            }}
          >
            {company.name?.charAt(0)}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>{company.name}</h1>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: s.bg,
                  color: s.color,
                  border: s.border,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dotColor }} />
                {company.status}
              </span>
            </div>
            <p style={{ fontSize: 14, color: "#859399", marginTop: 2, marginBottom: 0 }}>{company.description ?? ""}</p>
          </div>
        </div>
        <Link href="/companies" style={{ fontSize: 13, color: "#859399", textDecoration: "none" }}>&larr; Back</Link>
      </div>

      {/* Primitives */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
        {company.primitives?.map((p: string) => (
          <span
            key={p}
            style={{
              padding: "4px 10px",
              background: "rgba(0,209,255,0.08)",
              color: "#a4e6ff",
              fontSize: 12,
              borderRadius: 8,
              fontWeight: 600,
              border: "1px solid rgba(0,209,255,0.15)",
            }}
          >
            {p}
          </span>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.08)", marginBottom: 24 }}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                borderBottom: active ? "2px solid #00d1ff" : "2px solid transparent",
                marginBottom: -1,
                background: "transparent",
                color: active ? "#00d1ff" : "#859399",
                cursor: "pointer",
                transition: "color 0.2s",
              }}
            >
              {t.label}
              {t.count !== undefined && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 999,
                    background: active ? "rgba(0,209,255,0.15)" : "rgba(255,255,255,0.06)",
                    color: active ? "#a4e6ff" : "#859399",
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Overview */}
      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <StatBox label="Agents" value={company.agents?.length ?? 0} icon="agent" />
          <StatBox label="Pipelines" value={company.pipelines?.length ?? 0} icon="pipeline" />
          <StatBox label="Created" value={new Date(company.createdAt).toLocaleDateString()} icon="date" />
        </div>
      )}

      {/* Agents */}
      {tab === "agents" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
          {company.agents?.map((a: any) => {
            const isExpanded = expandedAgent === a.id;
            return (
              <div
                key={a.id}
                onClick={() => setExpandedAgent(isExpanded ? null : a.id)}
                style={{
                  background: isExpanded ? "rgba(29,32,38,0.95)" : "rgba(29,32,38,0.8)",
                  backdropFilter: "blur(24px)",
                  border: isExpanded ? "1px solid rgba(0,209,255,0.2)" : "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 16,
                  padding: 20,
                  cursor: "pointer",
                  transition: "border-color 0.2s, background 0.2s",
                }}
                onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; }}
                onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      background: "rgba(0,209,255,0.08)",
                      border: "1px solid rgba(0,209,255,0.15)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#00d1ff",
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    {a.name?.charAt(0)?.toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontWeight: 600, fontSize: 13, color: "#e1e2eb", margin: 0 }}>{a.name}</h3>
                    <p style={{ fontSize: 12, color: "#859399", margin: 0 }}>{a.role}</p>
                  </div>
                  <span
                    className="material-symbols-outlined"
                    style={{
                      fontSize: 16,
                      color: "#3c494e",
                      transform: isExpanded ? "rotate(180deg)" : "none",
                      transition: "transform 0.2s",
                    }}
                  >
                    expand_more
                  </span>
                </div>

                {a.tools?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {(a.tools as string[]).map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          background: "rgba(255,255,255,0.06)",
                          color: "#859399",
                          padding: "2px 8px",
                          borderRadius: 6,
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    {a.systemPrompt && (
                      <div style={{ marginBottom: 12 }}>
                        <p style={{ fontSize: 10, fontWeight: 600, color: "#859399", marginBottom: 4, letterSpacing: "0.05em" }}>SYSTEM PROMPT</p>
                        <p style={{ fontSize: 12, color: "#bbc9cf", lineHeight: 1.6, background: "rgba(0,209,255,0.04)", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(0,209,255,0.08)", whiteSpace: "pre-wrap" }}>
                          {a.systemPrompt.length > 300 ? a.systemPrompt.slice(0, 300) + "..." : a.systemPrompt}
                        </p>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 16 }}>
                      <div>
                        <p style={{ fontSize: 10, fontWeight: 600, color: "#859399", marginBottom: 2 }}>MODEL</p>
                        <p style={{ fontSize: 12, color: "#e1e2eb" }}>{a.model ?? "claude-sonnet"}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: 10, fontWeight: 600, color: "#859399", marginBottom: 2 }}>TOOLS</p>
                        <p style={{ fontSize: 12, color: "#e1e2eb" }}>{a.tools?.length ?? 0}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: 10, fontWeight: 600, color: "#859399", marginBottom: 2 }}>STATUS</p>
                        <p style={{ fontSize: 12, color: "#34d399" }}>Active</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {(!company.agents || company.agents.length === 0) && (
            <p style={{ color: "#859399", fontSize: 14, gridColumn: "span 2", textAlign: "center", padding: "48px 0" }}>No agents configured.</p>
          )}
        </div>
      )}

      {/* Pipelines */}
      {tab === "pipelines" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {company.pipelines?.map((p: any) => {
            const stepCount = (p.steps as any[])?.length ?? 0;
            return (
              <div
                key={p.id}
                style={{
                  background: "rgba(29,32,38,0.8)",
                  backdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 16,
                  padding: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      background: "rgba(52,211,153,0.1)",
                      border: "1px solid rgba(52,211,153,0.2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <svg width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="#34d399" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>
                  </div>
                  <div>
                    <h3 style={{ fontWeight: 600, fontSize: 13, color: "#e1e2eb", margin: 0 }}>{p.name}</h3>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 2 }}>
                      <span style={{ fontSize: 12, color: "#859399" }}>{p.trigger}</span>
                      {p.schedule && <span style={{ fontSize: 10, color: "#3c494e", fontFamily: "monospace" }}>{p.schedule}</span>}
                      <span style={{ fontSize: 12, color: "#3c494e" }}>{stepCount} step{stepCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!token) return;
                    try {
                      await api.triggerRun(token, p.id);
                      setTab("runs");
                    } catch {}
                  }}
                  style={{
                    padding: "8px 18px",
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#fff",
                    background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Run
                </button>
              </div>
            );
          })}
          {(!company.pipelines || company.pipelines.length === 0) && (
            <p style={{ color: "#859399", fontSize: 14, textAlign: "center", padding: "48px 0" }}>No pipelines configured.</p>
          )}
        </div>
      )}

      {/* Runs */}
      {tab === "runs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((r: any) => {
            const rs = runStatusStyles[r.status] ?? defaultRunStatus;
            return (
              <Link
                key={r.id}
                href={`/companies/${company.id}/runs/${r.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "rgba(29,32,38,0.8)",
                  backdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 12,
                  padding: "14px 20px",
                  textDecoration: "none",
                  transition: "border-color 0.2s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "#3c494e" }}>{r.id.slice(0, 10)}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#bbc9cf" }}>
                    {company.pipelines?.find((p: any) => p.id === r.pipelineId)?.name ?? "Unknown Pipeline"}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: rs.bg,
                      color: rs.color,
                      border: rs.border,
                    }}
                  >
                    {r.status}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ fontSize: 12, color: "#3c494e" }}>{new Date(r.createdAt).toLocaleString()}</span>
                  <svg width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="#3c494e" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                </div>
              </Link>
            );
          })}
          {runs.length === 0 && (
            <p style={{ color: "#859399", fontSize: 14, textAlign: "center", padding: "48px 0" }}>No runs yet. Trigger a pipeline to get started.</p>
          )}
        </div>
      )}

      {/* CRM */}
      {tab === "contacts" && <DealsKanban companyId={company.id} token={token!} />}

      {/* Memory */}
      {tab === "memory" && (
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
            <svg width={24} height={24} fill="none" viewBox="0 0 24 24" stroke="#e0b6ff" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>
          </div>
          <p style={{ fontWeight: 600, color: "#bbc9cf", fontSize: 13, margin: 0 }}>Company Memory</p>
          <p style={{ fontSize: 12, color: "#859399", marginTop: 4 }}>Learned patterns and insights will appear here as the company operates.</p>
        </div>
      )}
    </div>
  );
}

/* Sub Components */

function StatBox({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  const icons: Record<string, React.ReactNode> = {
    agent: (
      <svg width={20} height={20} fill="none" viewBox="0 0 24 24" stroke="#00d1ff" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" /></svg>
    ),
    pipeline: (
      <svg width={20} height={20} fill="none" viewBox="0 0 24 24" stroke="#34d399" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>
    ),
    date: (
      <svg width={20} height={20} fill="none" viewBox="0 0 24 24" stroke="#859399" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
    ),
  };

  return (
    <div
      style={{
        background: "rgba(29,32,38,0.8)",
        backdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16,
        padding: 20,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: "rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        {icons[icon]}
      </div>
      <p style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>{value}</p>
      <p style={{ fontSize: 12, color: "#859399", marginTop: 2, marginBottom: 0 }}>{label}</p>
    </div>
  );
}

const DEAL_STAGES = [
  { key: "LEAD",           label: "Lead",        bg: "rgba(255,255,255,0.02)",  border: "1px solid rgba(255,255,255,0.06)" },
  { key: "QUALIFIED",      label: "Qualified",   bg: "rgba(0,209,255,0.03)",    border: "1px solid rgba(0,209,255,0.12)" },
  { key: "PROPOSAL_SENT",  label: "Proposal",    bg: "rgba(251,191,36,0.03)",   border: "1px solid rgba(251,191,36,0.12)" },
  { key: "NEGOTIATION",    label: "Negotiation", bg: "rgba(251,146,60,0.03)",   border: "1px solid rgba(251,146,60,0.12)" },
  { key: "CLOSED_WON",     label: "Won",         bg: "rgba(52,211,153,0.03)",   border: "1px solid rgba(52,211,153,0.12)" },
  { key: "CLOSED_LOST",    label: "Lost",        bg: "rgba(239,68,68,0.03)",    border: "1px solid rgba(239,68,68,0.12)" },
];

function DealsKanban({ companyId, token }: { companyId: string; token: string }) {
  const [deals, setDeals] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<any[]>(`/crm/companies/${companyId}/deals`, { token }).catch(() => []),
      apiFetch<any[]>(`/crm/companies/${companyId}/contacts`, { token }).catch(() => []),
    ]).then(([d, c]) => {
      setDeals(d);
      setContacts(c);
      setLoading(false);
    });
  }, [companyId, token]);

  if (loading) return <div className="animate-shimmer" style={{ height: 192, borderRadius: 16, background: "rgba(255,255,255,0.04)" }} />;

  const dealsByStage = DEAL_STAGES.map((stage) => ({
    ...stage,
    deals: deals.filter((d) => d.stage === stage.key),
  }));

  return (
    <div>
      {/* Contacts */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#bbc9cf", marginBottom: 12 }}>Contacts ({contacts.length})</h3>
        {contacts.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {contacts.slice(0, 10).map((c: any) => (
              <div
                key={c.id}
                style={{
                  background: "rgba(29,32,38,0.8)",
                  backdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: "rgba(0,209,255,0.08)",
                    border: "1px solid rgba(0,209,255,0.15)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#00d1ff",
                    fontWeight: 700,
                    fontSize: 10,
                  }}
                >
                  {c.name?.charAt(0)?.toUpperCase() ?? "?"}
                </div>
                <span style={{ fontWeight: 500, fontSize: 12, color: "#bbc9cf" }}>{c.name}</span>
                <span style={{ fontSize: 10, color: "#859399" }}>{c.email}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "#3c494e" }}>No contacts yet.</p>
        )}
      </div>

      {/* Kanban */}
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "#bbc9cf", marginBottom: 12 }}>Deal Pipeline</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, overflowX: "auto" }}>
        {dealsByStage.map((stage) => (
          <div
            key={stage.key}
            style={{
              borderRadius: 12,
              border: stage.border,
              background: stage.bg,
              padding: 12,
              minHeight: 180,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h4 style={{ fontSize: 11, fontWeight: 600, color: "#859399", margin: 0 }}>{stage.label}</h4>
              <span
                style={{
                  fontSize: 10,
                  background: "rgba(255,255,255,0.06)",
                  color: "#859399",
                  padding: "2px 6px",
                  borderRadius: 999,
                  fontWeight: 500,
                }}
              >
                {stage.deals.length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {stage.deals.map((deal: any) => (
                <div
                  key={deal.id}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    borderRadius: 8,
                    padding: 12,
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <p style={{ fontSize: 12, fontWeight: 500, color: "#bbc9cf", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{deal.title}</p>
                  {deal.valueUsd > 0 && (
                    <p style={{ fontSize: 11, color: "#34d399", fontWeight: 600, marginTop: 4, marginBottom: 0 }}>${deal.valueUsd}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
