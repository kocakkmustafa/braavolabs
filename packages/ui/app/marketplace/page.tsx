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

const CATALOG_CATEGORIES = [
  { id: "", label: "All" },
  { id: "sales", label: "Sales" },
  { id: "content", label: "Content" },
  { id: "marketing", label: "Marketing" },
  { id: "operations", label: "Operations" },
];

export default function MarketplacePage() {
  const { token, hydrated } = useAuthGuard();
  const [blueprints, setBlueprints] = useState<any[]>([]);
  const [catalogBlueprints, setCatalogBlueprints] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"catalog" | "community">("catalog");
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [cloning, setCloning] = useState<string | null>(null);
  const [cloneResult, setCloneResult] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listBlueprints(token).then(setBlueprints).catch(() => []).finally(() => setLoading(false));
    api.listCatalogBlueprints(token).then(setCatalogBlueprints).catch(() => []).finally(() => setCatalogLoading(false));
  }, [token, hydrated]);

  async function handleClone(slug: string, isCatalog = false) {
    if (!token) return;
    setCloning(slug);
    try {
      let res: any;
      if (isCatalog) {
        res = await api.cloneCatalogBlueprint(token, slug);
      } else {
        res = await api.cloneBlueprint(token, slug);
      }
      setCloneResult(`Company "${res.company?.name ?? slug}" created successfully!`);
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

  const filteredCatalog = catalogBlueprints.filter((b) => {
    const matchSearch = !search || b.title?.toLowerCase().includes(search.toLowerCase()) || b.description?.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !selectedCategory || b.category === selectedCategory;
    return matchSearch && matchCategory;
  });

  const filteredCommunity = blueprints.filter((b) =>
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
            <p className="text-sm" style={{ color: "#859399" }}>{catalogBlueprints.length > 0 ? `${catalogBlueprints.length} ready-to-use AI company templates` : "Ready-to-use AI company templates"} + community blueprints</p>
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

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-xl w-fit" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
        {(["catalog", "community"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: activeTab === tab ? "rgba(0,209,255,0.12)" : "transparent",
              color: activeTab === tab ? "#00d1ff" : "#859399",
              border: activeTab === tab ? "1px solid rgba(0,209,255,0.2)" : "1px solid transparent",
            }}
          >
            {tab === "catalog" ? `Templates (${catalogBlueprints.length})` : `Community (${blueprints.length})`}
          </button>
        ))}
      </div>

      {/* Search + Category filter */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2" style={{ fontSize: 18, color: "#3c494e" }}>search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search blueprints..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
          />
        </div>
        {activeTab === "catalog" && (
          <div className="flex flex-wrap gap-1">
            {CATALOG_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
                style={{
                  background: selectedCategory === cat.id ? "rgba(0,209,255,0.1)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${selectedCategory === cat.id ? "rgba(0,209,255,0.3)" : "rgba(255,255,255,0.08)"}`,
                  color: selectedCategory === cat.id ? "#00d1ff" : "#859399",
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Catalog tab */}
      {activeTab === "catalog" && (
        <>
          {catalogLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="glass-card rounded-xl h-56 animate-shimmer" />
              ))}
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="glass-card rounded-2xl text-center py-16">
              <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>auto_awesome</span>
              <p className="font-semibold" style={{ color: "#e1e2eb" }}>No matching templates</p>
              <p className="text-sm mt-1" style={{ color: "#859399" }}>Try a different search or category filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCatalog.map((bp) => {
                const category = bp.category ?? bp.primitives?.[0] ?? "operations";
                return (
                  <div key={bp.slug} className="glass-card rounded-2xl p-5 flex flex-col">
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#00d1ff" }}>
                          {CATEGORY_ICONS[category] ?? "auto_awesome"}
                        </span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(109,17,173,0.15)", color: "#c084fc", border: "1px solid rgba(109,17,173,0.3)" }}>
                        TEMPLATE
                      </span>
                    </div>

                    <h3 className="font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>{bp.title}</h3>
                    <p className="text-xs mb-3 flex-1 line-clamp-3" style={{ color: "#859399", lineHeight: 1.6 }}>{bp.description}</p>

                    {bp.primitives && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {(bp.primitives as string[]).slice(0, 4).map((p) => (
                          <span key={p} className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ background: "rgba(0,209,255,0.08)", color: "#a4e6ff" }}>
                            {p}
                          </span>
                        ))}
                        {bp.primitives.length > 4 && (
                          <span className="text-[10px]" style={{ color: "#3c494e" }}>+{bp.primitives.length - 4}</span>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-4 mb-4">
                      <div className="flex items-center gap-1">
                        <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#859399" }}>smart_toy</span>
                        <span className="text-xs" style={{ color: "#859399" }}>{bp.agentCount} agents</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#859399" }}>account_tree</span>
                        <span className="text-xs" style={{ color: "#859399" }}>{bp.pipelineCount} pipelines</span>
                      </div>
                      {bp.estimatedRunCost && (
                        <div className="flex items-center gap-1">
                          <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#859399" }}>payments</span>
                          <span className="text-xs" style={{ color: "#859399" }}>{bp.estimatedRunCost}/run</span>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => handleClone(bp.slug, true)}
                      disabled={cloning === bp.slug}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                    >
                      {cloning === bp.slug ? (
                        <>
                          <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          Creating...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>rocket_launch</span>
                          Use This Template
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Community tab */}
      {activeTab === "community" && (
        <>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="glass-card rounded-xl h-56 animate-shimmer" />
              ))}
            </div>
          ) : filteredCommunity.length === 0 ? (
            <div className="glass-card rounded-2xl text-center py-16">
              <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>storefront</span>
              <p className="font-semibold" style={{ color: "#e1e2eb" }}>
                {blueprints.length === 0 ? "No community blueprints yet" : "No matching blueprints"}
              </p>
              <p className="text-sm mt-1" style={{ color: "#859399" }}>
                {blueprints.length === 0 ? "Be the first! Publish your company as a blueprint from the Company Detail page." : "Try a different search."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCommunity.map((bp) => {
                const category = bp.primitives?.[0] ?? "operations";
                return (
                  <div key={bp.slug} className="glass-card rounded-2xl p-5 flex flex-col">
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

                    <h3 className="font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>{bp.title ?? bp.slug}</h3>
                    <p className="text-xs mb-3 flex-1 line-clamp-3" style={{ color: "#859399", lineHeight: 1.6 }}>
                      {bp.description ?? "A ready-to-use AI company blueprint."}
                    </p>

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

                    <button
                      onClick={() => handleClone(bp.slug, false)}
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
        </>
      )}
    </div>
  );
}
