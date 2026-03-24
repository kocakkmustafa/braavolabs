"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
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

  if (!token) return <p className="text-slate-500 p-8">Please log in first.</p>;
  if (error) return <div className="max-w-4xl mx-auto px-6 py-8"><div className="bg-red-50 text-red-700 p-4 rounded-xl text-sm">{error}</div></div>;
  if (!company) return <div className="max-w-4xl mx-auto px-6 py-8"><div className="animate-shimmer h-8 w-48 rounded-lg" /></div>;

  const statusStyles: Record<string, { dot: string; bg: string; text: string }> = {
    ACTIVE: { dot: "bg-emerald-500", bg: "bg-emerald-50", text: "text-emerald-700" },
    PAUSED: { dot: "bg-amber-500", bg: "bg-amber-50", text: "text-amber-700" },
    ARCHIVED: { dot: "bg-red-400", bg: "bg-red-50", text: "text-red-600" },
  };
  const s = statusStyles[company.status] ?? { dot: "bg-slate-400", bg: "bg-slate-100", text: "text-slate-600" };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "agents", label: "Agents", count: company.agents?.length },
    { key: "pipelines", label: "Pipelines", count: company.pipelines?.length },
    { key: "runs", label: "Runs" },
    { key: "contacts", label: "CRM" },
    { key: "memory", label: "Memory" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl gradient-brand flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-brand-500/20">
            {company.name?.charAt(0)}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-900">{company.name}</h1>
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${s.bg} ${s.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                {company.status}
              </span>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">{company.description ?? ""}</p>
          </div>
        </div>
        <a href="/companies" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">&larr; Back</a>
      </div>

      {/* Primitives */}
      <div className="flex flex-wrap gap-2 mb-6">
        {company.primitives?.map((p: string) => (
          <span key={p} className="px-2.5 py-1 bg-brand-50 text-brand-700 text-xs rounded-lg font-semibold">{p}</span>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
              tab === t.key
                ? "border-brand-600 text-brand-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                tab === t.key ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500"
              }`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Overview ──────────────────────────── */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatBox label="Agents" value={company.agents?.length ?? 0} icon="agent" />
          <StatBox label="Pipelines" value={company.pipelines?.length ?? 0} icon="pipeline" />
          <StatBox label="Created" value={new Date(company.createdAt).toLocaleDateString()} icon="date" />
        </div>
      )}

      {/* ── Agents ────────────────────────────── */}
      {tab === "agents" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {company.agents?.map((a: any) => (
            <div key={a.id} className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600 font-bold text-sm">
                  {a.name?.charAt(0)?.toUpperCase()}
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-slate-900">{a.name}</h3>
                  <p className="text-xs text-slate-500">{a.role}</p>
                </div>
              </div>
              {a.tools?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {(a.tools as string[]).map((t) => (
                    <span key={t} className="text-[10px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {(!company.agents || company.agents.length === 0) && (
            <p className="text-slate-500 text-sm col-span-2 text-center py-12">No agents configured.</p>
          )}
        </div>
      )}

      {/* ── Pipelines ─────────────────────────── */}
      {tab === "pipelines" && (
        <div className="space-y-3">
          {company.pipelines?.map((p: any) => {
            const stepCount = (p.steps as any[])?.length ?? 0;
            return (
              <div key={p.id} className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-slate-900">{p.name}</h3>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-slate-500">{p.trigger}</span>
                      {p.schedule && <span className="text-[10px] text-slate-400 font-mono">{p.schedule}</span>}
                      <span className="text-xs text-slate-400">{stepCount} step{stepCount !== 1 ? "s" : ""}</span>
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
                  className="px-4 py-2 rounded-lg text-xs font-semibold text-white gradient-brand hover:shadow-lg transition-all"
                >
                  Run
                </button>
              </div>
            );
          })}
          {(!company.pipelines || company.pipelines.length === 0) && (
            <p className="text-slate-500 text-sm text-center py-12">No pipelines configured.</p>
          )}
        </div>
      )}

      {/* ── Runs ──────────────────────────────── */}
      {tab === "runs" && (
        <div className="space-y-2">
          {runs.map((r: any) => {
            const runStatus: Record<string, string> = {
              COMPLETED: "bg-emerald-50 text-emerald-700",
              FAILED: "bg-red-50 text-red-700",
              RUNNING: "bg-blue-50 text-blue-700",
              PAUSED: "bg-amber-50 text-amber-700",
              CANCELLED: "bg-slate-100 text-slate-600",
            };
            return (
              <a
                key={r.id}
                href={`/companies/${company.id}/runs/${r.id}`}
                className="flex items-center justify-between bg-white rounded-xl border border-slate-200/60 shadow-sm px-5 py-4 hover:shadow-md transition-all group"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-slate-500">{r.id.slice(0, 10)}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${runStatus[r.status] ?? "bg-slate-100 text-slate-600"}`}>
                    {r.status}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-slate-400">{new Date(r.createdAt).toLocaleString()}</span>
                  <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                </div>
              </a>
            );
          })}
          {runs.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-12">No runs yet. Trigger a pipeline to get started.</p>
          )}
        </div>
      )}

      {/* ── CRM (Contacts & Deals) ────────────── */}
      {tab === "contacts" && <DealsKanban companyId={company.id} token={token!} />}

      {/* ── Memory ────────────────────────────── */}
      {tab === "memory" && (
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm text-center py-16">
          <div className="w-12 h-12 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>
          </div>
          <p className="font-semibold text-slate-700 text-sm">Company Memory</p>
          <p className="text-xs text-slate-500 mt-1">Learned patterns and insights will appear here as the company operates.</p>
        </div>
      )}
    </div>
  );
}

/* ─── Sub Components ──────────────────────────────────────── */

function StatBox({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  const icons: Record<string, React.ReactNode> = {
    agent: <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" /></svg>,
    pipeline: <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>,
    date: <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>,
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5">
      <div className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center mb-3">
        {icons[icon]}
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}

const DEAL_STAGES = [
  { key: "LEAD", label: "Lead", color: "bg-slate-50 border-slate-200" },
  { key: "QUALIFIED", label: "Qualified", color: "bg-blue-50/50 border-blue-200" },
  { key: "PROPOSAL_SENT", label: "Proposal", color: "bg-amber-50/50 border-amber-200" },
  { key: "NEGOTIATION", label: "Negotiation", color: "bg-orange-50/50 border-orange-200" },
  { key: "CLOSED_WON", label: "Won", color: "bg-emerald-50/50 border-emerald-200" },
  { key: "CLOSED_LOST", label: "Lost", color: "bg-red-50/50 border-red-200" },
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

  if (loading) return <div className="animate-shimmer h-48 rounded-2xl" />;

  const dealsByStage = DEAL_STAGES.map((stage) => ({
    ...stage,
    deals: deals.filter((d) => d.stage === stage.key),
  }));

  return (
    <div>
      {/* Contacts */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Contacts ({contacts.length})</h3>
        {contacts.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {contacts.slice(0, 10).map((c: any) => (
              <div key={c.id} className="bg-white rounded-xl border border-slate-200/60 shadow-sm px-3 py-2 text-sm flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-brand-50 flex items-center justify-center text-brand-600 font-bold text-[10px]">
                  {c.name?.charAt(0)?.toUpperCase() ?? "?"}
                </div>
                <span className="font-medium text-xs text-slate-700">{c.name}</span>
                <span className="text-[10px] text-slate-400">{c.email}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">No contacts yet.</p>
        )}
      </div>

      {/* Kanban */}
      <h3 className="text-sm font-semibold text-slate-700 mb-3">Deal Pipeline</h3>
      <div className="grid grid-cols-6 gap-3 overflow-x-auto">
        {dealsByStage.map((stage) => (
          <div key={stage.key} className={`rounded-xl border p-3 min-h-[180px] ${stage.color}`}>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-slate-700">{stage.label}</h4>
              <span className="text-[10px] bg-white text-slate-500 px-1.5 py-0.5 rounded-full font-medium">
                {stage.deals.length}
              </span>
            </div>
            <div className="space-y-2">
              {stage.deals.map((deal: any) => (
                <div key={deal.id} className="bg-white rounded-lg shadow-sm p-3 border border-slate-100">
                  <p className="text-xs font-medium truncate text-slate-800">{deal.title}</p>
                  {deal.valueUsd > 0 && (
                    <p className="text-[11px] text-emerald-600 font-semibold mt-1">${deal.valueUsd}</p>
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
