"use client";

/**
 * /connections — connect & monitor external automations (n8n / Make / Zapier).
 *
 * The connect-don't-rebuild pillar: point Braavolabs at an existing automation
 * platform and the backend poller mirrors its executions into ExternalRun, so
 * this page shows live cross-platform run status no incumbent unifies. The
 * API key is encrypted server-side and never returned.
 *
 * Strings are hardcoded English to match the bv-* detail-page convention
 * (/pipelines/[id], /runs/[id]); the Phase 5 i18n sweep localizes these views.
 */

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { timeAgo } from "../../lib/timeAgo";

const PLATFORMS = [
  { value: "N8N", label: "n8n" },
  { value: "MAKE", label: "Make" },
  { value: "ZAPIER", label: "Zapier" },
  { value: "GENERIC", label: "Generic (REST)" },
];

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#34d399",
  PENDING: "#fbbf24",
  ERROR: "#f87171",
  DISABLED: "#859399",
};

const RUN_DOT: Record<string, string> = {
  COMPLETED: "#34d399",
  RUNNING: "#a4e6ff",
  FAILED: "#f87171",
  CANCELLED: "#c084fc",
  PENDING: "#fbbf24",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function ConnectionsPage() {
  const { token, hydrated } = useAuthGuard();
  const [conns, setConns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, any[]>>({});

  const [showForm, setShowForm] = useState(false);
  const [fPlatform, setFPlatform] = useState("N8N");
  const [fLabel, setFLabel] = useState("");
  const [fBaseUrl, setFBaseUrl] = useState("");
  const [fApiKey, setFApiKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  function load() {
    if (!token) return;
    api.listExternalConnections(token).then(setConns).catch(() => {}).finally(() => setLoading(false));
  }
  useEffect(() => {
    if (hydrated && token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token]);

  async function loadRuns(id: string) {
    if (!token) return;
    try {
      const r = await api.externalRuns(token, id);
      setRuns((p) => ({ ...p, [id]: r }));
    } catch { /* ignore */ }
  }

  function toggle(id: string) {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next && !runs[next]) loadRuns(next);
  }

  async function create() {
    if (!token || !fLabel.trim() || !fBaseUrl.trim() || !fApiKey.trim()) return;
    setCreating(true);
    setFormErr(null);
    try {
      await api.createExternalConnection(token, {
        platform: fPlatform,
        label: fLabel.trim(),
        baseUrl: fBaseUrl.trim(),
        apiKey: fApiKey.trim(),
      });
      setShowForm(false);
      setFLabel("");
      setFBaseUrl("");
      setFApiKey("");
      load();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setCreating(false);
    }
  }

  async function pollNow(id: string) {
    if (!token) return;
    setBusy(id);
    try {
      await api.pollExternalConnection(token, id);
      load();
      if (expanded === id) await loadRuns(id);
    } catch { /* ignore */ }
    setBusy(null);
  }

  async function remove(id: string) {
    if (!token) return;
    setBusy(id);
    try {
      await api.deleteExternalConnection(token, id);
      setConns((p) => p.filter((c) => c.id !== id));
    } catch { /* ignore */ }
    setBusy(null);
  }

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
      </div>
    );
  }

  const inputStyle = { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Connections</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>Monitor your n8n, Make &amp; Zapier automations in one place.</p>
        </div>
        <button
          onClick={() => { setFormErr(null); setShowForm(true); }}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white self-start sm:self-auto"
          style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add_link</span>
          Connect
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">{[1, 2].map((i) => <div key={i} className="glass-card rounded-xl h-20 animate-shimmer" />)}</div>
      ) : conns.length === 0 ? (
        <div className="glass-card rounded-2xl text-center py-16">
          <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>hub</span>
          <p className="font-semibold" style={{ color: "#e1e2eb" }}>No connections yet</p>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>Connect an n8n, Make, or Zapier instance to watch its runs here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {conns.map((c) => {
            const sc = STATUS_COLOR[c.status] ?? "#859399";
            const isOpen = expanded === c.id;
            return (
              <div key={c.id} className="glass-card rounded-xl overflow-hidden" style={{ borderLeft: `3px solid ${sc}` }}>
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#00d1ff" }}>hub</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm" style={{ color: "#e1e2eb" }}>{c.label}</span>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold" style={{ color: sc, background: `${sc}1a`, border: `1px solid ${sc}33` }}>{c.status}</span>
                        <span className="text-[10px] uppercase tracking-wider" style={{ color: "#3c494e" }}>{c.platform}</span>
                      </div>
                      <p className="text-xs truncate" style={{ color: "#859399" }}>{hostOf(c.baseUrl)}</p>
                      {c.lastError && <p className="text-xs truncate" style={{ color: "#f87171" }}>{c.lastError}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs" style={{ color: "#859399" }}>{c.lastPolledAt ? `Polled ${timeAgo(c.lastPolledAt)}` : "Not polled yet"}</span>
                    <button onClick={() => pollNow(c.id)} disabled={busy === c.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.2)", color: "#a4e6ff" }}>
                      {busy === c.id ? <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <span className="material-symbols-outlined" style={{ fontSize: 14 }}>sync</span>}
                      Poll now
                    </button>
                    <button onClick={() => toggle(c.id)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>expand_more</span>
                      Runs
                    </button>
                    <button onClick={() => remove(c.id)} disabled={busy === c.id} className="flex items-center px-2 py-1.5 rounded-lg text-xs disabled:opacity-50" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }} title="Disconnect">
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: 14 }}>
                    {!runs[c.id] ? (
                      <p className="text-xs" style={{ color: "#859399" }}>Loading runs…</p>
                    ) : runs[c.id].length === 0 ? (
                      <p className="text-xs" style={{ color: "#859399" }}>No runs mirrored yet. Hit “Poll now” to fetch the latest executions.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {runs[c.id].map((r) => (
                          <li key={r.id} className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: RUN_DOT[r.status] ?? "#859399" }} />
                            <span className="text-xs font-medium truncate" style={{ color: "#e1e2eb", flex: 1 }}>{r.workflowName ?? r.externalId}</span>
                            <span className="text-[11px]" style={{ color: "#859399" }}>{r.status}</span>
                            <span className="text-[11px]" style={{ color: "#3c494e" }}>{r.startedAt ? timeAgo(r.startedAt) : ""}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div onClick={() => !creating && setShowForm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} className="rounded-2xl p-6 w-full max-w-md" style={{ background: "#0f1219", border: "1px solid rgba(255,255,255,0.1)" }}>
            <h2 className="text-lg font-bold font-headline mb-1" style={{ color: "#e1e2eb" }}>Connect an automation</h2>
            <p className="text-xs mb-4" style={{ color: "#859399" }}>We poll its execution history; your API key is encrypted and never shown again.</p>

            <label className="block text-xs mb-1" style={{ color: "#859399" }}>Platform</label>
            <select value={fPlatform} onChange={(e) => setFPlatform(e.target.value)} className="w-full mb-3 px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle}>
              {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>

            <label className="block text-xs mb-1" style={{ color: "#859399" }}>Label</label>
            <input value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="My production n8n" className="w-full mb-3 px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />

            <label className="block text-xs mb-1" style={{ color: "#859399" }}>Base URL</label>
            <input value={fBaseUrl} onChange={(e) => setFBaseUrl(e.target.value)} placeholder="https://n8n.example.com" className="w-full mb-3 px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />

            <label className="block text-xs mb-1" style={{ color: "#859399" }}>API key</label>
            <input value={fApiKey} onChange={(e) => setFApiKey(e.target.value)} type="password" placeholder="••••••••" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />

            {formErr && <p className="text-xs mt-2" style={{ color: "#f87171" }}>{formErr}</p>}

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowForm(false)} disabled={creating} className="px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>Cancel</button>
              <button onClick={create} disabled={creating || !fLabel.trim() || !fBaseUrl.trim() || !fApiKey.trim()} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}>{creating ? "Connecting…" : "Connect"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
