"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

const CATEGORY_ICONS: Record<string, string> = {
  content: "edit_note",
  sales: "work",
  marketing: "campaign",
  operations: "account_tree",
  finance: "payments",
  support: "support_agent",
};

export default function MarketplacePage() {
  const { token, hydrated } = useAuthGuard();
  const [blueprints, setBlueprints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloning, setCloning] = useState<string | null>(null);
  const [cloneResult, setCloneResult] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listBlueprints(token).then(setBlueprints).catch(() => []).finally(() => setLoading(false));
  }, [token, hydrated]);

  async function handleClone(slug: string) {
    if (!token) return;
    setCloning(slug);
    try {
      const res = await api.cloneBlueprint(token, slug);
      setCloneResult(`Company "${res.company?.name ?? slug}" cloned successfully!`);
      setTimeout(() => setCloneResult(null), 4000);
    } catch (err) {
      setCloneResult(`Error: ${(err as Error).message}`);
    }
    setCloning(null);
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  const filtered = blueprints.filter((b) =>
    !search || b.title?.toLowerCase().includes(search.toLowerCase()) || b.description?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}>
            <span className="material-symbols-outlined text-white" style={{ fontSize: 20 }}>storefront</span>
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Blueprint Marketplace</h1>
            <p className="text-sm" style={{ color: "#859399" }}>Clone proven AI company templates in one click</p>
          </div>
        </div>
      </div>

      {/* Clone result toast */}
      {cloneResult && (
        <div
          className="mb-6 px-4 py-3 rounded-xl text-sm"
          style={{
            background: cloneResult.startsWith("Error") ? "rgba(239,68,68,0.1)" : "rgba(52,211,153,0.1)",
            border: `1px solid ${cloneResult.startsWith("Error") ? "rgba(239,68,68,0.2)" : "rgba(52,211,153,0.2)"}`,
            color: cloneResult.startsWith("Error") ? "#f87171" : "#34d399",
          }}
        >
          {cloneResult}
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2" style={{ fontSize: 18, color: "#3c494e" }}>search</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blueprints..."
          className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
        />
      </div>

      {/* Blueprint grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="glass-card rounded-xl h-56 animate-shimmer" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card rounded-2xl text-center py-16">
          <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>storefront</span>
          <p className="font-semibold" style={{ color: "#e1e2eb" }}>
            {blueprints.length === 0 ? "No blueprints published yet" : "No matching blueprints"}
          </p>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>
            {blueprints.length === 0 ? "Be the first! Publish your company as a blueprint from the Company Detail page." : "Try a different search."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((bp) => {
            const category = bp.primitives?.[0] ?? "operations";
            return (
              <div key={bp.slug} className="glass-card rounded-2xl p-5 flex flex-col">
                {/* Card header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#00d1ff" }}>
                      {CATEGORY_ICONS[category] ?? "auto_awesome"}
                    </span>
                  </div>
                  {bp.cloneCount > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#3c494e" }}>content_copy</span>
                      <span className="text-xs" style={{ color: "#3c494e" }}>{bp.cloneCount}</span>
                    </div>
                  )}
                </div>

                {/* Title */}
                <h3 className="font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>{bp.title ?? bp.slug}</h3>
                <p className="text-xs mb-3 flex-1 line-clamp-3" style={{ color: "#859399", lineHeight: 1.6 }}>
                  {bp.description ?? "A ready-to-use AI company blueprint."}
                </p>

                {/* Primitives */}
                {bp.primitives && (
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {bp.primitives.slice(0, 4).map((p: string) => (
                      <span key={p} className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ background: "rgba(0,209,255,0.08)", color: "#a4e6ff" }}>
                        {p}
                      </span>
                    ))}
                    {bp.primitives.length > 4 && (
                      <span className="text-[10px]" style={{ color: "#3c494e" }}>+{bp.primitives.length - 4}</span>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div className="flex items-center gap-4 mb-4">
                  {bp.agentCount != null && (
                    <div className="flex items-center gap-1">
                      <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#859399" }}>smart_toy</span>
                      <span className="text-xs" style={{ color: "#859399" }}>{bp.agentCount} agents</span>
                    </div>
                  )}
                  {bp.pipelineCount != null && (
                    <div className="flex items-center gap-1">
                      <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#859399" }}>account_tree</span>
                      <span className="text-xs" style={{ color: "#859399" }}>{bp.pipelineCount} pipelines</span>
                    </div>
                  )}
                </div>

                {/* Clone button */}
                <button
                  onClick={() => handleClone(bp.slug)}
                  disabled={cloning === bp.slug}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all hover:brightness-110 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                >
                  {cloning === bp.slug ? (
                    <>
                      <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Cloning...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>content_copy</span>
                      Clone This Blueprint
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Publish CTA */}
      <div className="mt-8 glass-card rounded-2xl p-6 text-center" style={{ border: "1px solid rgba(0,209,255,0.15)" }}>
        <span className="material-symbols-outlined text-3xl mb-3 block" style={{ color: "#00d1ff" }}>share</span>
        <p className="font-semibold mb-1" style={{ color: "#e1e2eb" }}>Share Your Blueprint</p>
        <p className="text-sm mb-4" style={{ color: "#859399" }}>
          Publish any of your companies as a blueprint so others can clone and learn from your setup.
        </p>
        <Link
          href="/companies"
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold"
          style={{ background: "rgba(0,209,255,0.08)", color: "#00d1ff", border: "1px solid rgba(0,209,255,0.2)", textDecoration: "none" }}
        >
          Go to Companies
        </Link>
      </div>
    </div>
  );
}
