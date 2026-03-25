"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function CompaniesPage() {
  const token = useAppStore((s) => s.token);
  const [companies, setCompanies] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => {});
  }, [token]);

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

  const statusStyles: Record<string, { dot: string; bg: string; text: string; border: string }> = {
    ACTIVE: { dot: "bg-emerald-500", bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
    PAUSED: { dot: "bg-amber-500", bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
    DRAFT: { dot: "bg-slate-500", bg: "bg-slate-500/10", text: "text-slate-400", border: "border-slate-500/20" },
    ARCHIVED: { dot: "bg-red-500", bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20" },
  };

  const primitiveColors: Record<string, string> = {
    CONTENT: "bg-violet-500/10 text-violet-400 border-violet-500/20",
    ACQUISITION: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    SALES: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    DELIVERY: "bg-teal-500/10 text-teal-400 border-teal-500/20",
    ANALYTICS: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    OPERATIONS: "bg-slate-500/10 text-slate-400 border-slate-500/20",
    FINANCE: "bg-green-500/10 text-green-400 border-green-500/20",
    MEMORY: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    GOVERNANCE: "bg-red-500/10 text-red-400 border-red-500/20",
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Companies</h1>
          <p className="text-sm text-slate-500 mt-0.5">{companies.length} {companies.length !== 1 ? "companies" : "company"} created</p>
        </div>
        <a
          href="/companies/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white gradient-brand shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          New Company
        </a>
      </div>

      {companies.length === 0 ? (
        <div className="card-glass text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21" /></svg>
          </div>
          <p className="font-semibold text-slate-200">No companies yet</p>
          <p className="text-sm text-slate-500 mt-1 mb-6">Describe your business idea and AI will set everything up</p>
          <a
            href="/companies/new"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white gradient-brand"
          >
            Create Your First Company
          </a>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {companies.map((c) => {
            const s = statusStyles[c.status] ?? statusStyles.DRAFT;
            return (
              <a
                key={c.id}
                href={`/companies/${c.id}`}
                className="group card-glass-hover overflow-hidden"
              >
                {/* Top accent bar */}
                <div className="h-0.5 gradient-brand opacity-40 group-hover:opacity-80 transition-opacity" />

                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl gradient-brand flex items-center justify-center text-white font-bold text-sm shrink-0 shadow-lg shadow-brand-500/20">
                        {c.name?.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-100 group-hover:text-brand-300 transition-colors">
                          {c.name}
                        </h3>
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${s.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                          {c.status}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-500 line-clamp-2 mb-4 leading-relaxed">
                    {c.description ?? "No description"}
                  </p>

                  {/* Primitives */}
                  <div className="flex flex-wrap gap-1.5">
                    {c.primitives?.map((p: string) => (
                      <span
                        key={p}
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${primitiveColors[p] ?? "bg-slate-500/10 text-slate-400 border-slate-500/20"}`}
                      >
                        {p}
                      </span>
                    ))}
                  </div>

                  {/* Footer stats */}
                  <div className="flex items-center gap-4 mt-4 pt-4 border-t border-white/[0.06] text-xs text-slate-600">
                    <span>{c._count?.agents ?? c.agents?.length ?? 0} agents</span>
                    <span>{c._count?.pipelines ?? c.pipelines?.length ?? 0} pipelines</span>
                    <span className="ml-auto">{new Date(c.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
