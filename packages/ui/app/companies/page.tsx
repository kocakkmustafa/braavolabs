"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function CompaniesPage() {
  const token = useAppStore((s) => s.token);
  const [companies, setCompanies] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => {});
  }, [token]);

  if (!token) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: "#0a0d14" }}>
      <p className="text-sm" style={{ color: "#859399" }}>Please <Link href="/login" style={{ color: "#00d1ff" }}>login</Link> first.</p>
    </div>
  );

  const statusStyles: Record<string, { dot: string; color: string }> = {
    ACTIVE: { dot: "#10b981", color: "#34d399" },
    PAUSED: { dot: "#f59e0b", color: "#fbbf24" },
    DRAFT: { dot: "#859399", color: "#bbc9cf" },
    ARCHIVED: { dot: "#ef4444", color: "#f87171" },
  };

  const primitiveColors: Record<string, { bg: string; color: string; border: string }> = {
    CONTENT:    { bg: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "rgba(109,17,173,0.3)" },
    ACQUISITION:{ bg: "rgba(0,209,255,0.1)", color: "#a4e6ff", border: "rgba(0,209,255,0.25)" },
    SALES:      { bg: "rgba(0,209,255,0.1)", color: "#a4e6ff", border: "rgba(0,209,255,0.25)" },
    DELIVERY:   { bg: "rgba(0,209,255,0.08)", color: "#a4e6ff", border: "rgba(0,209,255,0.2)" },
    ANALYTICS:  { bg: "rgba(109,17,173,0.1)", color: "#e0b6ff", border: "rgba(109,17,173,0.25)" },
    OPERATIONS: { bg: "rgba(133,147,153,0.1)", color: "#bbc9cf", border: "rgba(133,147,153,0.2)" },
    FINANCE:    { bg: "rgba(0,209,255,0.08)", color: "#a4e6ff", border: "rgba(0,209,255,0.2)" },
    MEMORY:     { bg: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "rgba(109,17,173,0.3)" },
    GOVERNANCE: { bg: "rgba(239,68,68,0.1)", color: "#f87171", border: "rgba(239,68,68,0.2)" },
  };
  const defaultPrimitive = { bg: "rgba(133,147,153,0.1)", color: "#bbc9cf", border: "rgba(133,147,153,0.2)" };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Companies</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>
            {companies.length} {companies.length !== 1 ? "companies" : "company"} created
          </p>
        </div>
        <Link
          href="/companies/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
        >
          <span className="material-symbols-outlined text-base">add</span>
          New Company
        </Link>
      </div>

      {companies.length === 0 ? (
        <div className="glass-card rounded-2xl text-center py-20">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.2)" }}
          >
            <span className="material-symbols-outlined text-3xl" style={{ color: "#a4e6ff" }}>business</span>
          </div>
          <p className="font-semibold" style={{ color: "#e1e2eb" }}>No companies yet</p>
          <p className="text-sm mt-1 mb-6" style={{ color: "#859399" }}>
            Describe your business idea and AI will set everything up
          </p>
          <Link
            href="/companies/new"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            Create Your First Company
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 stagger-children">
          {companies.map((c) => {
            const s = statusStyles[c.status] ?? statusStyles.DRAFT;
            return (
              <Link
                key={c.id}
                href={`/companies/${c.id}`}
                className="group rounded-2xl overflow-hidden transition-all hover:scale-[1.01] hover:border-[rgba(0,209,255,0.2)] hover:shadow-[0_0_20px_rgba(0,209,255,0.08)]"
                style={{
                  display: "block",
                  background: "rgba(29,32,38,0.7)",
                  backdropFilter: "blur(20px)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                {/* Top accent bar */}
                <div
                  className="h-0.5 transition-opacity opacity-40 group-hover:opacity-80"
                  style={{ background: "linear-gradient(to right, #00d1ff, #6d11ad)" }}
                />

                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0"
                        style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
                      >
                        {c.name?.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-semibold" style={{ color: "#e1e2eb" }}>{c.name}</h3>
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: s.color }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />
                          {c.status}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs line-clamp-2 mb-4 leading-relaxed" style={{ color: "#859399" }}>
                    {c.description ?? "No description"}
                  </p>

                  {/* Primitives */}
                  <div className="flex flex-wrap gap-1.5">
                    {c.primitives?.map((p: string) => {
                      const pc = primitiveColors[p] ?? defaultPrimitive;
                      return (
                        <span
                          key={p}
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-md"
                          style={{ background: pc.bg, color: pc.color, border: `1px solid ${pc.border}` }}
                        >
                          {p}
                        </span>
                      );
                    })}
                  </div>

                  {/* Footer stats */}
                  <div
                    className="flex items-center gap-4 mt-4 pt-4 text-xs"
                    style={{ borderTop: "1px solid rgba(255,255,255,0.06)", color: "#3c494e" }}
                  >
                    <span>{c._count?.agents ?? c.agents?.length ?? 0} agents</span>
                    <span>{c._count?.pipelines ?? c.pipelines?.length ?? 0} pipelines</span>
                    <span className="ml-auto">{new Date(c.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
