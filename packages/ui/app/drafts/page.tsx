"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  REVIEW: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  APPROVED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  PUBLISHED: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  REJECTED: "bg-red-500/10 text-red-400 border-red-500/20",
};

const TYPE_LABELS: Record<string, string> = {
  SOCIAL_POST: "Social Post",
  EMAIL: "Email",
  BLOG_POST: "Blog Post",
  AD_COPY: "Ad Copy",
  VIDEO_SCRIPT: "Video Script",
};

export default function DraftsPage() {
  const token = useAppStore((s) => s.token);
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then((list) => {
      setCompanies(list);
      if (list.length > 0) setSelectedCompany(list[0].id);
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token || !selectedCompany) return;
    setLoading(true);
    api.listDrafts(token, selectedCompany)
      .then(setDrafts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, selectedCompany]);

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

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
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Drafts</h1>
          <p className="text-sm text-slate-500 mt-0.5">Content created by your AI agents</p>
        </div>
        <select
          value={selectedCompany}
          onChange={(e) => setSelectedCompany(e.target.value)}
          className="bg-white/[0.04] border border-white/[0.08] text-slate-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500/50 outline-none"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id} className="bg-[#1a1d27]">{c.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="animate-shimmer h-24 rounded-2xl" />)}
        </div>
      ) : drafts.length === 0 ? (
        <div className="card-glass text-center py-16">
          <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
          </div>
          <p className="font-semibold text-slate-300">No drafts yet</p>
          <p className="text-sm text-slate-500 mt-1">Drafts will appear here when agents create content.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((d) => (
            <div key={d.id} className="card-glass p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold text-slate-200">{d.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[d.status] ?? ""}`}>
                      {d.status}
                    </span>
                    <span className="text-xs bg-violet-500/10 text-violet-400 border border-violet-500/20 px-2 py-0.5 rounded">
                      {TYPE_LABELS[d.type] ?? d.type}
                    </span>
                  </div>
                  {d.channel && (
                    <p className="text-sm text-slate-500">Channel: {d.channel}</p>
                  )}
                  {d.content && (
                    <div className="mt-2 text-sm text-slate-400 bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 max-h-32 overflow-auto whitespace-pre-wrap">
                      {typeof d.content === "string" ? d.content : JSON.stringify(d.content, null, 2)}
                    </div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-slate-600">
                    <span>Created: {new Date(d.createdAt).toLocaleString()}</span>
                    {d.scheduledAt && (
                      <span>Scheduled: {new Date(d.scheduledAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 ml-4">
                  {d.status === "DRAFT" && (
                    <button
                      onClick={() => updateStatus(d.id, "APPROVED")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
                    >
                      Approve
                    </button>
                  )}
                  {(d.status === "DRAFT" || d.status === "REVIEW") && (
                    <button
                      onClick={() => updateStatus(d.id, "REJECTED")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                    >
                      Reject
                    </button>
                  )}
                  {d.status === "APPROVED" && (
                    <button
                      onClick={() => updateStatus(d.id, "PUBLISHED")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors"
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
