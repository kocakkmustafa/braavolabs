"use client";

/**
 * /connections — connect & monitor external automations (n8n / Make / Zapier).
 *
 * The connect-don't-rebuild pillar: point Braavolabs at an existing automation
 * platform and the backend poller mirrors its executions into ExternalRun, so
 * this page shows live cross-platform run status no incumbent unifies. The
 * API key is encrypted server-side and never returned.
 *
 * Localized via next-intl (app.connections) across all 6 locales. Platform
 * brand names (n8n / Make / Zapier) and raw status enums stay untranslated.
 */

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { timeAgo } from "../../lib/timeAgo";
import { useTranslations } from "next-intl";

const PLATFORMS = [
  { value: "N8N", label: "n8n" },
  { value: "MAKE", label: "Make" },
  { value: "ZAPIER", label: "Zapier" },
  { value: "GENERIC", label: "Generic (REST)" },
];

// FORGE palette — map to bv-* / Tailwind FORGE tokens, never hardcode old hexes.
const PLATFORM_GLYPH: Record<string, string> = {
  N8N: "n8n",
  MAKE: "Mk",
  ZAPIER: "Zp",
  GENERIC: "{ }",
};

// Platform accent: arc-blue gradient for all (no old brand colours)
const PLATFORM_GRADIENT: Record<string, string> = {
  N8N: "linear-gradient(135deg,#3B82F6,#1E3A8A)",
  MAKE: "linear-gradient(135deg,#2563EB,#1E3A8A)",
  ZAPIER: "linear-gradient(135deg,#60A5FA,#3B82F6)",
  GENERIC: "linear-gradient(135deg,#3B82F6,#2563EB)",
};

// Status → bv-dot class + bv-pill class
const STATUS_DOT: Record<string, string> = {
  ACTIVE: "bv-completed",
  PENDING: "bv-pending",
  ERROR: "bv-failed",
  DISABLED: "bv-cancelled",
};
const STATUS_PILL: Record<string, string> = {
  ACTIVE: "bv-pill-cyan",
  PENDING: "bv-pill-amber",
  ERROR: "bv-pill-red",
  DISABLED: "bv-pill-muted",
};

const RUN_DOT: Record<string, string> = {
  COMPLETED: "bv-completed",
  RUNNING: "bv-running bv-ping",
  FAILED: "bv-failed",
  CANCELLED: "bv-cancelled",
  PENDING: "bv-pending",
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
  const t = useTranslations();
  const [conns, setConns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, any[]>>({});
  // Control plane — discovered automations + per-card action state.
  const [workflows, setWorkflows] = useState<Record<string, any[]>>({});
  const [ctlBusy, setCtlBusy] = useState<string | null>(null);
  const [ctlMsg, setCtlMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [webhookUrl, setWebhookUrl] = useState<Record<string, string>>({});

  const [showForm, setShowForm] = useState(false);
  const [fPlatform, setFPlatform] = useState("N8N");
  const [fLabel, setFLabel] = useState("");
  const [fBaseUrl, setFBaseUrl] = useState("");
  const [fApiKey, setFApiKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  // F3 — result of the live credential validation that runs on connect.
  // Shown as a success/warning banner after the connection is created.
  const [validationResult, setValidationResult] = useState<
    { validated: boolean; recentRuns?: number; error?: string } | null
  >(null);

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

  async function discover(id: string) {
    if (!token) return;
    try {
      const w = await api.discoverExternalWorkflows(token, id);
      setWorkflows((p) => ({ ...p, [id]: w }));
    } catch {
      setWorkflows((p) => ({ ...p, [id]: [] }));
    }
  }

  // Run a control action, then refresh the card status + the discovered list so
  // the active/paused state reflects reality. One action per card at a time.
  async function control(id: string, type: "TRIGGER" | "PAUSE" | "RESUME", targetId: string) {
    if (!token || !targetId) return;
    setCtlBusy(id);
    setCtlMsg((p) => ({ ...p, [id]: undefined as any }));
    try {
      const res = await api.controlExternalConnection(token, id, { type, targetId });
      setCtlMsg((p) => ({ ...p, [id]: { ok: true, text: res.detail ?? t("app.connections.controlOk") } }));
      load();
      const conn = conns.find((c) => c.id === id);
      if (conn?.capabilities?.discover) discover(id);
    } catch (e) {
      setCtlMsg((p) => ({
        ...p,
        [id]: { ok: false, text: e instanceof Error ? e.message : t("app.connections.controlFailed") },
      }));
    } finally {
      setCtlBusy(null);
    }
  }

  function toggle(id: string) {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next && !runs[next]) loadRuns(next);
    if (next) {
      const conn = conns.find((c) => c.id === next);
      if (conn?.capabilities?.discover && !workflows[next]) discover(next);
    }
  }

  async function create() {
    if (!token || !fLabel.trim() || !fBaseUrl.trim() || !fApiKey.trim()) return;
    setCreating(true);
    setFormErr(null);
    setValidationResult(null);
    try {
      const res = await api.createExternalConnection(token, {
        platform: fPlatform,
        label: fLabel.trim(),
        baseUrl: fBaseUrl.trim(),
        apiKey: fApiKey.trim(),
      });
      // F3: the connection was created either way. Surface whether the live
      // validation reached the platform so the user gets instant feedback.
      setValidationResult({
        validated: !!res.validated,
        recentRuns: res.recentRuns,
        error: res.validationError,
      });
      setShowForm(false);
      setFLabel("");
      setFBaseUrl("");
      setFApiKey("");
      load();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : t("app.connections.connectFailed"));
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
        <div className="w-6 h-6 rounded-full animate-spin" style={{ border: "2px solid rgba(59,130,246,0.2)", borderTopColor: "#3B82F6" }} />
      </div>
    );
  }

  return (
    <div className="bv-dash bv-dash-shell min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 animate-fade-in">

        {/* ── Page head ── */}
        <div className="bv-page-head mb-8">
          <div>
            <p className="bv-micro text-on-surface-variant mb-1">Automation Hub</p>
            <h1 className="bv-headline text-on-surface">{t("app.connections.title")}</h1>
            <p className="bv-body text-on-surface-variant mt-1">{t("app.connections.subtitle")}</p>
          </div>
          <div className="bv-page-head-actions">
            <button
              onClick={() => { setFormErr(null); setShowForm(true); }}
              className="bv-btn bv-btn-primary"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add_link</span>
              {t("app.connections.connect")}
            </button>
          </div>
        </div>

        {/* ── F3: live-validation result banner ── */}
        {validationResult && (
          <div
            className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl"
            style={{
              background: validationResult.validated
                ? "rgba(59,130,246,0.07)"
                : "rgba(255,122,26,0.08)",
              border: `1px solid ${
                validationResult.validated ? "rgba(96,165,250,0.25)" : "rgba(255,122,26,0.3)"
              }`,
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: 18,
                color: validationResult.validated ? "#60A5FA" : "#FF7A1A",
                marginTop: 1,
              }}
            >
              {validationResult.validated ? "check_circle" : "warning"}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                className="bv-body"
                style={{
                  color: validationResult.validated ? "#60A5FA" : "#FF7A1A",
                  fontWeight: 500,
                  margin: 0,
                }}
              >
                {validationResult.validated
                  ? t("app.connections.validatedOk", { n: validationResult.recentRuns ?? 0 })
                  : t("app.connections.validatedFail", {
                      error: validationResult.error ?? t("app.connections.connectFailed"),
                    })}
              </p>
              {!validationResult.validated && (
                <p className="bv-caption" style={{ margin: "2px 0 0" }}>
                  {t("app.connections.validatedFailHint")}
                </p>
              )}
            </div>
            <button
              onClick={() => setValidationResult(null)}
              className="bv-btn bv-btn-ghost bv-btn-icon"
              aria-label="Dismiss"
              style={{ flexShrink: 0 }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        )}

        {/* ── Connection cards grid ── */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            {[1, 2].map((i) => (
              <div key={i} className="bv-glass animate-shimmer" style={{ height: 140 }} />
            ))}
          </div>
        ) : conns.length === 0 ? (
          <div className="bv-glass bv-rise text-center py-16 mb-8">
            <span className="material-symbols-outlined text-4xl mb-4 block text-primary">hub</span>
            <p className="bv-title mb-1">{t("app.connections.emptyTitle")}</p>
            <p className="bv-caption">{t("app.connections.emptyBody")}</p>
            {/* Add connection card */}
            <button
              onClick={() => { setFormErr(null); setShowForm(true); }}
              className="bv-btn bv-btn-ghost mt-6"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add_circle</span>
              Connect a new automation
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8 bv-stagger">
            {conns.map((c) => {
              const dotCls = STATUS_DOT[c.status] ?? "bv-cancelled";
              const pillCls = STATUS_PILL[c.status] ?? "bv-pill-muted";
              const platGlyph = PLATFORM_GLYPH[c.platform] ?? "{ }";
              const platGrad = PLATFORM_GRADIENT[c.platform] ?? PLATFORM_GRADIENT.GENERIC;
              const isOpen = expanded === c.id;
              return (
                <div key={c.id} className="bv-glass overflow-hidden">
                  {/* Card top */}
                  <div className="p-5">
                    <div className="flex items-start gap-3 mb-4">
                      {/* Platform glyph badge */}
                      <div
                        className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0 font-mono font-semibold text-white text-[13px]"
                        style={{ background: platGrad, letterSpacing: "0.02em" }}
                      >
                        {platGlyph}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="bv-title truncate">{c.label}</span>
                          <span className={`bv-pill ${pillCls}`}>{c.status}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="bv-micro">{c.platform}</span>
                          <span className="bv-divider-dot" />
                          <span className="bv-caption truncate">{hostOf(c.baseUrl)}</span>
                        </div>
                        {c.lastError && (
                          <p className="bv-caption truncate mt-1" style={{ color: "var(--bv-status-failed)" }}>{c.lastError}</p>
                        )}
                      </div>
                      {/* Live status dot */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={`bv-dot ${dotCls}${c.status === "ACTIVE" ? " bv-ping" : ""}`} />
                      </div>
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center justify-between">
                      <span className="bv-caption">
                        {c.lastPolledAt
                          ? t("app.connections.polledAgo", { time: timeAgo(c.lastPolledAt) })
                          : t("app.connections.notPolled")}
                      </span>
                    </div>
                  </div>

                  {/* Card actions footer */}
                  <div className="bv-divider" />
                  <div className="flex items-center gap-2 px-5 py-3">
                    <button
                      onClick={() => pollNow(c.id)}
                      disabled={busy === c.id}
                      className="bv-btn bv-btn-ghost bv-btn-sm flex-1 disabled:opacity-50"
                    >
                      {busy === c.id ? (
                        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>sync</span>
                      )}
                      {t("app.connections.pollNow")}
                    </button>
                    <button
                      onClick={() => toggle(c.id)}
                      className="bv-btn bv-btn-ghost bv-btn-sm flex-1"
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 14, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                      >
                        expand_more
                      </span>
                      {t("app.connections.runsToggle")}
                    </button>
                    <button
                      onClick={() => remove(c.id)}
                      disabled={busy === c.id}
                      className="bv-btn bv-btn-danger bv-btn-sm bv-btn-icon disabled:opacity-50"
                      title={t("app.connections.disconnect")}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                    </button>
                  </div>

                  {/* Expanded: control plane + mirrored runs */}
                  {isOpen && (
                    <div>
                      <div className="bv-divider" />
                      {/* ── Control plane (capability-gated) ── */}
                      <div className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="material-symbols-outlined text-primary" style={{ fontSize: 15 }}>tune</span>
                          <span className="bv-micro uppercase tracking-widest text-on-surface">{t("app.connections.controlTitle")}</span>
                        </div>
                        {c.capabilities?.discover ? (
                          !workflows[c.id] ? (
                            <p className="bv-caption">{t("app.connections.discovering")}</p>
                          ) : workflows[c.id].length === 0 ? (
                            <p className="bv-caption">{t("app.connections.noAutomations")}</p>
                          ) : (
                            <ul className="flex flex-col gap-1.5">
                              {workflows[c.id].map((w) => (
                                <li
                                  key={w.id}
                                  className="flex items-center gap-2 px-3 py-2 rounded-[10px]"
                                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
                                >
                                  <span className={`bv-dot ${w.active ? "bv-completed" : "bv-cancelled"}`} />
                                  <span className="bv-body font-medium truncate text-on-surface flex-1">{w.name}</span>
                                  <span className="bv-pill bv-pill-muted">
                                    {w.active ? t("app.connections.activeTag") : t("app.connections.pausedTag")}
                                  </span>
                                  {c.capabilities?.trigger && (
                                    <button
                                      onClick={() => control(c.id, "TRIGGER", w.id)}
                                      disabled={ctlBusy === c.id}
                                      className="bv-btn bv-btn-ghost bv-btn-sm bv-btn-icon disabled:opacity-50"
                                      title={t("app.connections.trigger")}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                                    </button>
                                  )}
                                  {c.capabilities?.pauseResume && (
                                    <button
                                      onClick={() => control(c.id, w.active ? "PAUSE" : "RESUME", w.id)}
                                      disabled={ctlBusy === c.id}
                                      className="bv-btn bv-btn-ghost bv-btn-sm bv-btn-icon disabled:opacity-50"
                                      title={w.active ? t("app.connections.pause") : t("app.connections.resume")}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                                        {w.active ? "pause" : "play_circle"}
                                      </span>
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )
                        ) : c.capabilities?.trigger ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={webhookUrl[c.id] ?? ""}
                              onChange={(e) => setWebhookUrl((p) => ({ ...p, [c.id]: e.target.value }))}
                              placeholder={t("app.connections.webhookUrlPlaceholder")}
                              className="flex-1 px-3 py-2 rounded-xl text-sm text-on-surface outline-none"
                              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                            />
                            <button
                              onClick={() => control(c.id, "TRIGGER", webhookUrl[c.id] ?? "")}
                              disabled={!webhookUrl[c.id] || ctlBusy === c.id}
                              className="bv-btn bv-btn-primary bv-btn-sm disabled:opacity-50"
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>bolt</span>
                              {t("app.connections.triggerWebhook")}
                            </button>
                          </div>
                        ) : (
                          <p className="bv-caption">{t("app.connections.monitorOnly")}</p>
                        )}
                        {ctlMsg[c.id] && (
                          <p
                            className="bv-caption mt-2"
                            style={{ color: ctlMsg[c.id].ok ? "#60A5FA" : "var(--bv-status-failed)" }}
                          >
                            {ctlMsg[c.id].text}
                          </p>
                        )}
                      </div>
                      <div className="bv-divider" />
                      <div className="px-5 py-4">
                        {!runs[c.id] ? (
                          <p className="bv-caption">{t("app.connections.loadingRuns")}</p>
                        ) : runs[c.id].length === 0 ? (
                          <p className="bv-caption">{t("app.connections.noRuns")}</p>
                        ) : (
                          <ul className="flex flex-col gap-1.5">
                            {runs[c.id].map((r) => (
                              <li
                                key={r.id}
                                className="flex items-center gap-3 px-3 py-2 rounded-[10px]"
                                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
                              >
                                <span className={`bv-dot ${RUN_DOT[r.status] ?? "bv-cancelled"}`} />
                                <span className="bv-body font-medium truncate text-on-surface flex-1">{r.workflowName ?? r.externalId}</span>
                                <span className="bv-pill bv-pill-muted">{r.status}</span>
                                <span className="bv-mono text-outline">{r.startedAt ? timeAgo(r.startedAt) : ""}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Add card */}
            <button
              onClick={() => { setFormErr(null); setShowForm(true); }}
              className="bv-glass flex flex-col items-center justify-center gap-3 cursor-pointer min-h-[140px] text-on-surface-variant hover:text-on-surface transition-colors"
              style={{ borderStyle: "dashed" }}
            >
              <span
                className="w-11 h-11 rounded-xl flex items-center justify-center text-primary"
                style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.25)", fontSize: 22 }}
              >
                +
              </span>
              <span className="bv-body">Connect a new automation</span>
            </button>
          </div>
        )}

        {/* ── Unified executions feed ── */}
        {!loading && conns.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-5">
              <h2 className="bv-title font-headline uppercase tracking-widest text-on-surface">Unified executions</h2>
              <span className="bv-caption">native + external · one timeline</span>
            </div>

            <div className="bv-glass bv-panel">
              {/* Feed header row */}
              <div className="bv-runs-row bv-runs-head" style={{ gridTemplateColumns: "24px 1fr auto" }}>
                <span />
                <span>event</span>
                <span>type</span>
              </div>

              {/* Feed rows — populated from expanded conn runs or a merged list when available */}
              {Object.entries(runs).flatMap(([connId, connRuns]) =>
                connRuns.map((r) => {
                  const conn = conns.find((c) => c.id === connId);
                  const dotCls = RUN_DOT[r.status] ?? "bv-cancelled";
                  return (
                    <div
                      key={r.id}
                      className="grid gap-3 items-center py-3 border-b border-outline-variant last:border-b-0"
                      style={{ gridTemplateColumns: "24px 1fr auto" }}
                    >
                      {/* Timeline node */}
                      <div className="flex flex-col items-center self-stretch">
                        <span className={`bv-dot ${dotCls} mt-1`} />
                        <div className="flex-1 w-px mt-1" style={{ background: "linear-gradient(180deg,rgba(91,100,115,0.3),transparent)" }} />
                      </div>

                      {/* Text */}
                      <div>
                        <p className="bv-body text-on-surface">{r.workflowName ?? r.externalId}</p>
                        <p className="bv-mono text-outline mt-0.5">
                          {conn?.platform ?? "external"} · {r.startedAt ? timeAgo(r.startedAt) : ""}
                        </p>
                      </div>

                      {/* Tag */}
                      <span className="bv-pill bv-pill-amber">external</span>
                    </div>
                  );
                })
              )}
              {Object.keys(runs).length === 0 && (
                <p className="bv-caption py-4 text-center">Expand a connection to mirror its executions here.</p>
              )}
            </div>
          </section>
        )}
      </div>

      {/* ── Connect modal ── */}
      {showForm && (
        <div
          onClick={() => !creating && setShowForm(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(3,4,7,0.72)",
            backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24, zIndex: 90
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bv-glass bv-rise w-full max-w-[480px] overflow-hidden"
            style={{ borderRadius: 20 }}
          >
            {/* Modal header */}
            <div
              className="flex items-center gap-3 px-6 py-5"
              style={{ borderBottom: "1px solid rgba(58,65,80,0.25)" }}
            >
              <span className="material-symbols-outlined text-primary" style={{ fontSize: 20 }}>hub</span>
              <h3 className="bv-title uppercase tracking-widest flex-1">{t("app.connections.formTitle")}</h3>
              <button
                onClick={() => setShowForm(false)}
                className="bv-btn bv-btn-ghost bv-btn-icon"
                aria-label="Close"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>

            {/* Step indicator */}
            <div className="flex gap-2 px-6 pt-5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex-1 h-[3px] rounded-full"
                  style={{
                    background: i === 0
                      ? "linear-gradient(90deg,#3B82F6,#2563EB)"
                      : "rgba(58,65,80,0.35)"
                  }}
                />
              ))}
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 flex flex-col gap-4">
              <p className="bv-caption">{t("app.connections.formSubtitle")}</p>

              {/* Platform picker grid */}
              <div className="grid grid-cols-2 gap-2">
                {PLATFORMS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setFPlatform(p.value)}
                    className="flex items-center gap-2.5 px-3 py-3 rounded-[11px] text-sm text-on-surface transition-all"
                    style={{
                      background: fPlatform === p.value ? "rgba(59,130,246,0.10)" : "rgba(20,23,31,0.5)",
                      border: `1px solid ${fPlatform === p.value ? "rgba(59,130,246,0.40)" : "rgba(58,65,80,0.35)"}`,
                    }}
                  >
                    <span
                      className="w-[30px] h-[30px] rounded-lg flex items-center justify-center font-mono font-semibold text-white text-[11px] flex-shrink-0"
                      style={{ background: PLATFORM_GRADIENT[p.value] }}
                    >
                      {PLATFORM_GLYPH[p.value]}
                    </span>
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Label */}
              <div className="flex flex-col gap-1">
                <label className="bv-micro">{t("app.connections.labelLabel")}</label>
                <input
                  value={fLabel}
                  onChange={(e) => setFLabel(e.target.value)}
                  placeholder={t("app.connections.labelPlaceholder")}
                  className="w-full px-3 py-2 rounded-xl text-sm text-on-surface outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                />
              </div>

              {/* Base URL */}
              <div className="flex flex-col gap-1">
                <label className="bv-micro">{t("app.connections.baseUrlLabel")}</label>
                <input
                  value={fBaseUrl}
                  onChange={(e) => setFBaseUrl(e.target.value)}
                  placeholder="https://n8n.example.com"
                  className="w-full px-3 py-2 rounded-xl text-sm text-on-surface outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                />
              </div>

              {/* API Key */}
              <div className="flex flex-col gap-1">
                <label className="bv-micro">{t("app.connections.apiKeyLabel")}</label>
                <input
                  value={fApiKey}
                  onChange={(e) => setFApiKey(e.target.value)}
                  type="password"
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-xl text-sm text-on-surface outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                />
              </div>

              {formErr && (
                <p className="bv-caption" style={{ color: "var(--bv-status-failed)" }}>{formErr}</p>
              )}
            </div>

            {/* Modal footer */}
            <div
              className="flex justify-end gap-2 px-6 py-4"
              style={{ borderTop: "1px solid rgba(58,65,80,0.25)" }}
            >
              <button
                onClick={() => setShowForm(false)}
                disabled={creating}
                className="bv-btn bv-btn-ghost bv-btn-sm disabled:opacity-50"
              >
                {t("app.pipelines.nlCancel")}
              </button>
              <button
                onClick={create}
                disabled={creating || !fLabel.trim() || !fBaseUrl.trim() || !fApiKey.trim()}
                className="bv-btn bv-btn-primary bv-btn-sm disabled:opacity-50"
              >
                {creating ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    {t("app.connections.connecting")}
                  </>
                ) : (
                  t("app.connections.connect")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
