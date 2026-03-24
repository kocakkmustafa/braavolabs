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

  if (!token) return <p className="text-gray-500">Please log in first.</p>;
  if (error) return <div className="bg-red-50 text-red-700 p-4 rounded">{error}</div>;
  if (!company) return <p className="text-gray-500">Loading...</p>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "pipelines", label: "Pipelines" },
    { key: "agents", label: "Agents" },
    { key: "runs", label: "Runs" },
    { key: "contacts", label: "Contacts & Deals" },
    { key: "memory", label: "Memory" },
  ];

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800",
    PAUSED: "bg-yellow-100 text-yellow-800",
    ARCHIVED: "bg-red-100 text-red-800",
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{company.name}</h1>
          <p className="text-gray-500 text-sm">{company.description ?? ""}</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusColors[company.status] ?? "bg-gray-100"}`}>
          {company.status}
        </span>
      </div>

      {/* Primitives */}
      <div className="flex flex-wrap gap-2 mb-6">
        {company.primitives?.map((p: string) => (
          <span key={p} className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">{p}</span>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-500">Agents</p>
            <p className="text-3xl font-bold mt-1">{company.agents?.length ?? 0}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-500">Pipelines</p>
            <p className="text-3xl font-bold mt-1">{company.pipelines?.length ?? 0}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-500">Created</p>
            <p className="text-lg font-semibold mt-1">{new Date(company.createdAt).toLocaleDateString()}</p>
          </div>
        </div>
      )}

      {tab === "pipelines" && (
        <div className="space-y-4">
          {company.pipelines?.map((p: any) => (
            <div key={p.id} className="bg-white rounded-lg shadow p-6 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-sm text-gray-500">
                  Trigger: {p.trigger} | Steps: {(p.steps as any[])?.length ?? 0}
                </p>
              </div>
              <button
                onClick={async () => {
                  if (!token) return;
                  try {
                    const res = await api.triggerRun(token, p.id);
                    setTab("runs");
                  } catch {}
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
              >
                Run
              </button>
            </div>
          ))}
          {(!company.pipelines || company.pipelines.length === 0) && (
            <p className="text-gray-500 text-center py-8">No pipelines configured.</p>
          )}
        </div>
      )}

      {tab === "agents" && (
        <div className="space-y-4">
          {company.agents?.map((a: any) => (
            <div key={a.id} className="bg-white rounded-lg shadow p-6">
              <h3 className="font-semibold">{a.name}</h3>
              <p className="text-sm text-gray-500 mt-1">Role: {a.role}</p>
              {a.tools?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {(a.tools as string[]).map((t) => (
                    <span key={t} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-3">
          {runs.map((r: any) => (
            <a
              key={r.id}
              href={`/companies/${company.id}/runs/${r.id}`}
              className="block bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{r.id.slice(0, 8)}...</span>
                  <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
                    r.status === "COMPLETED" ? "bg-green-100 text-green-700" :
                    r.status === "FAILED" ? "bg-red-100 text-red-700" :
                    r.status === "RUNNING" ? "bg-blue-100 text-blue-700" :
                    "bg-gray-100 text-gray-700"
                  }`}>
                    {r.status}
                  </span>
                </div>
                <span className="text-sm text-gray-500">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
            </a>
          ))}
          {runs.length === 0 && (
            <p className="text-gray-500 text-center py-8">No runs yet. Trigger a pipeline to get started.</p>
          )}
        </div>
      )}

      {tab === "contacts" && (
        <p className="text-gray-500 text-center py-8">CRM contacts and deals will appear here.</p>
      )}

      {tab === "memory" && (
        <p className="text-gray-500 text-center py-8">Company memory items will appear here.</p>
      )}
    </div>
  );
}
