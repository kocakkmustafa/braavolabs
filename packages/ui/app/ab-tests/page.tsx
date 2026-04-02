"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  DRAFT: { bg: "rgba(133,147,153,0.12)", color: "#859399", border: "rgba(133,147,153,0.2)" },
  RUNNING: { bg: "rgba(0,209,255,0.12)", color: "#00d1ff", border: "rgba(0,209,255,0.2)" },
  PAUSED: { bg: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "rgba(251,191,36,0.2)" },
  COMPLETED: { bg: "rgba(52,211,153,0.12)", color: "#34d399", border: "rgba(52,211,153,0.2)" },
};

interface AbTest {
  id: string;
  name: string;
  description?: string;
  status: string;
  agentName?: string;
  companyName?: string;
  variantCount: number;
  totalRuns?: number;
  startedAt?: string;
  createdAt: string;
  winnerVariantId?: string;
  variants?: any[];
}

export default function AbTestsPage() {
  const { token, hydrated } = useAuthGuard();
  const [tests, setTests] = useState<AbTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [companies, setCompanies] = useState<any[]>([]);

  // Create form
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCompanyId, setNewCompanyId] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [agents, setAgents] = useState<any[]>([]);
  const [variants, setVariants] = useState([
    { name: "Variant A", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
    { name: "Variant B", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
  ]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listAbTests(token, statusFilter || undefined)
      .then(setTests)
      .catch(() => setTests([]))
      .finally(() => setLoading(false));
  }, [token, statusFilter]);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => []);
  }, [token]);

  useEffect(() => {
    if (!token || !newCompanyId) { setAgents([]); return; }
    api.listAgents(token, newCompanyId).then(setAgents).catch(() => []);
  }, [token, newCompanyId]);

  async function handleCreate() {
    if (!token || !newName || !newCompanyId || !newAgentId) return;
    setCreating(true);
    try {
      await api.createAbTest(token, {
        companyId: newCompanyId,
        agentId: newAgentId,
        name: newName,
        description: newDesc || undefined,
        variants,
      });
      setShowCreate(false);
      setNewName(""); setNewDesc(""); setNewCompanyId(""); setNewAgentId("");
      setVariants([
        { name: "Variant A", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
        { name: "Variant B", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
      ]);
      // Refresh
      api.listAbTests(token, statusFilter || undefined).then(setTests).catch(() => {});
    } catch (err) {
      alert((err as Error).message);
    }
    setCreating(false);
  }

  async function handleAction(id: string, action: "start" | "pause" | "complete" | "delete") {
    if (!token) return;
    try {
      if (action === "start") await api.startAbTest(token, id);
      else if (action === "pause") await api.pauseAbTest(token, id);
      else if (action === "complete") await api.completeAbTest(token, id);
      else if (action === "delete") await api.deleteAbTest(token, id);
      api.listAbTests(token, statusFilter || undefined).then(setTests).catch(() => {});
    } catch (err) {
      alert((err as Error).message);
    }
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">A/B Testing</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>
            Test agent variants and find the best performing configuration
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 self-start"
          style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          New A/B Test
        </button>
      </div>

      {/* Status filter */}
      <div className="flex gap-1.5 mb-6">
        {[
          { id: "", label: "All" },
          { id: "DRAFT", label: "Draft" },
          { id: "RUNNING", label: "Running" },
          { id: "PAUSED", label: "Paused" },
          { id: "COMPLETED", label: "Completed" },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background: statusFilter === f.id ? "rgba(0,209,255,0.12)" : "rgba(255,255,255,0.04)",
              color: statusFilter === f.id ? "#00d1ff" : "#859399",
              border: statusFilter === f.id ? "1px solid rgba(0,209,255,0.2)" : "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tests list */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
        </div>
      ) : tests.length === 0 ? (
        <div className="text-center py-16 glass-card rounded-2xl">
          <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: "#3c494e" }}>science</span>
          <p className="font-semibold mb-1" style={{ color: "#e1e2eb" }}>No A/B tests yet</p>
          <p className="text-sm mb-4" style={{ color: "#859399" }}>Create your first experiment to optimize agent performance.</p>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            Create A/B Test
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {tests.map((test) => {
            const st = STATUS_STYLES[test.status] ?? STATUS_STYLES.DRAFT;
            const isExpanded = expandedId === test.id;

            return (
              <div
                key={test.id}
                className="glass-card rounded-2xl overflow-hidden"
                style={{ border: isExpanded ? "1px solid rgba(0,209,255,0.12)" : undefined }}
              >
                <div
                  className="p-5 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : test.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(0,209,255,0.08)" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>science</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>{test.name}</p>
                        <p className="text-xs" style={{ color: "#3c494e" }}>
                          {test.companyName && `${test.companyName} · `}{test.agentName && `${test.agentName} · `}
                          {test.variantCount} variants{test.totalRuns ? ` · ${test.totalRuns} runs` : ""}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                        style={{ background: st.bg, color: st.color, border: `1px solid ${st.border}` }}
                      >
                        {test.status}
                      </span>
                      <span className="material-symbols-outlined text-sm" style={{ color: "#3c494e", transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                        expand_more
                      </span>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-5 pb-5" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                    {test.description && (
                      <p className="text-xs mt-3 mb-3" style={{ color: "#859399" }}>{test.description}</p>
                    )}

                    {/* Variant cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 mt-3">
                      {test.variants?.map((v: any, i: number) => (
                        <div
                          key={v.id ?? i}
                          className="rounded-xl p-3"
                          style={{
                            background: v.id === test.winnerVariantId ? "rgba(52,211,153,0.08)" : "rgba(255,255,255,0.02)",
                            border: v.id === test.winnerVariantId ? "1px solid rgba(52,211,153,0.2)" : "1px solid rgba(255,255,255,0.06)",
                          }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold" style={{ color: "#e1e2eb" }}>
                              {v.name}
                              {v.id === test.winnerVariantId && (
                                <span className="ml-1.5 text-[10px]" style={{ color: "#34d399" }}>WINNER</span>
                              )}
                            </span>
                            <span className="text-[10px]" style={{ color: "#3c494e" }}>{v.weight}% traffic</span>
                          </div>
                          {v.metrics && v.metrics.length > 0 && (
                            <div className="space-y-1">
                              {v.metrics.map((m: any) => (
                                <div key={m.metric} className="flex justify-between text-[10px]">
                                  <span style={{ color: "#859399" }}>{m.metric}</span>
                                  <span style={{ color: "#bbc9cf" }}>{m.avgValue?.toFixed(2)} ({m.count} samples)</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      {test.status === "DRAFT" && (
                        <>
                          <button onClick={() => handleAction(test.id, "start")} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(0,209,255,0.12)", color: "#00d1ff", border: "1px solid rgba(0,209,255,0.2)" }}>
                            Start Test
                          </button>
                          <button onClick={() => handleAction(test.id, "delete")} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.15)" }}>
                            Delete
                          </button>
                        </>
                      )}
                      {test.status === "RUNNING" && (
                        <>
                          <button onClick={() => handleAction(test.id, "pause")} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" }}>
                            Pause
                          </button>
                          <button onClick={() => handleAction(test.id, "complete")} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(52,211,153,0.12)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
                            Complete
                          </button>
                        </>
                      )}
                      {test.status === "PAUSED" && (
                        <button onClick={() => handleAction(test.id, "start")} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(0,209,255,0.12)", color: "#00d1ff", border: "1px solid rgba(0,209,255,0.2)" }}>
                          Resume
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-[560px] rounded-2xl p-6 max-h-[85vh] overflow-y-auto" style={{ background: "#191c22", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-bold text-base" style={{ color: "#e1e2eb" }}>Create A/B Test</h3>
              <button onClick={() => setShowCreate(false)} style={{ color: "#859399", background: "none", border: "none", cursor: "pointer" }}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Test Name</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Tone comparison for outreach agent" className="w-full px-4 py-2.5 rounded-xl text-sm outline-none" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }} />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Description (optional)</label>
                <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What are you testing?" className="w-full px-4 py-2.5 rounded-xl text-sm outline-none" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Company</label>
                  <select value={newCompanyId} onChange={(e) => setNewCompanyId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl text-sm outline-none" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}>
                    <option value="">Select company</option>
                    {companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Agent</label>
                  <select value={newAgentId} onChange={(e) => setNewAgentId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl text-sm outline-none" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }} disabled={!newCompanyId}>
                    <option value="">Select agent</option>
                    {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Variants */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold" style={{ color: "#bbc9cf" }}>Variants</label>
                  <button
                    onClick={() => setVariants([...variants, { name: `Variant ${String.fromCharCode(65 + variants.length)}`, config: { systemPrompt: "", temperature: 0.7 }, weight: Math.floor(100 / (variants.length + 1)) }])}
                    className="text-xs px-2 py-1 rounded-lg"
                    style={{ color: "#00d1ff", background: "rgba(0,209,255,0.08)" }}
                  >
                    + Add Variant
                  </button>
                </div>

                <div className="space-y-3">
                  {variants.map((v, i) => (
                    <div key={i} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          value={v.name}
                          onChange={(e) => { const nv = [...variants]; nv[i].name = e.target.value; setVariants(nv); }}
                          className="flex-1 px-3 py-1.5 rounded-lg text-xs outline-none"
                          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#e1e2eb" }}
                        />
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={v.weight}
                            onChange={(e) => { const nv = [...variants]; nv[i].weight = parseInt(e.target.value) || 0; setVariants(nv); }}
                            className="w-14 px-2 py-1.5 rounded-lg text-xs text-center outline-none"
                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#e1e2eb" }}
                          />
                          <span className="text-[10px]" style={{ color: "#3c494e" }}>%</span>
                        </div>
                        {variants.length > 2 && (
                          <button onClick={() => setVariants(variants.filter((_, j) => j !== i))} style={{ color: "#f87171", background: "none", border: "none", cursor: "pointer" }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                          </button>
                        )}
                      </div>
                      <textarea
                        value={v.config.systemPrompt}
                        onChange={(e) => { const nv = [...variants]; nv[i].config.systemPrompt = e.target.value; setVariants(nv); }}
                        placeholder="System prompt override..."
                        rows={2}
                        className="w-full px-3 py-2 rounded-lg text-xs outline-none resize-none"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#e1e2eb" }}
                      />
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[10px]" style={{ color: "#3c494e" }}>Temperature:</span>
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="0.1"
                          value={v.config.temperature}
                          onChange={(e) => { const nv = [...variants]; nv[i].config.temperature = parseFloat(e.target.value); setVariants(nv); }}
                          className="flex-1"
                        />
                        <span className="text-[10px] w-6 text-right" style={{ color: "#859399" }}>{v.config.temperature}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: "rgba(255,255,255,0.04)", color: "#859399", border: "1px solid rgba(255,255,255,0.06)" }}>
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName || !newCompanyId || !newAgentId}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
              >
                {creating ? "Creating..." : "Create Test"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
