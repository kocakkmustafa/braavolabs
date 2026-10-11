"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, apiFetch, SessionChangedError } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import { useToast } from "../../../components/Toast";
import { useTranslations } from "next-intl";
import ComparePanel from "../../../components/ComparePanel";
import { captureAuthSession, isAuthSessionCurrent, useAppStore } from "../../../lib/store";

type Tab = "overview" | "pipelines" | "agents" | "runs" | "contacts" | "memory" | "compare";
type CompanyScope = {
  revision: number; tenantId: string | null; companyId: string; active: boolean;
  modelRequest?: object; autonomyRequest?: object; composerRequest?: object;
};
type ActionState = {
  scope: CompanyScope;
  modelSaving: boolean; modelError: string | null;
  composerLoading: boolean; composerError: string | null;
  composerResult: { name: string; droppedTools: string[]; provider: string; model: string } | null;
  savingAutonomyId: string | null;
};
const blankActions = (scope: CompanyScope): ActionState => ({
  scope, modelSaving: false, modelError: null, composerLoading: false,
  composerError: null, composerResult: null, savingAutonomyId: null,
});

export default function CompanyDetailPage() {
  const params = useParams();
  const { token, hydrated } = useAuthGuard();
  const revision = useAppStore(s => s.sessionRevision);
  const tenantId = useAppStore(s => s.tenantId);
  const companyId = params.id as string;
  const { toast } = useToast();
  const t = useTranslations();
  // Token rotation keeps this identity; a new login, tenant or route retires it
  // during render, before effect cleanup can run.
  const scope = useMemo<CompanyScope>(() => ({ revision, tenantId, companyId, active: false }), [revision, tenantId, companyId]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [loadedCompany, setLoadedCompany] = useState<{ scope: typeof scope; data: any } | null>(null);
  const [tab, setTab] = useState<Tab>("agents");
  const [runs, setRuns] = useState<any[]>([]);
  const [loadedError, setLoadedError] = useState<{ scope: typeof scope; message: string } | null>(null);
  const company = loadedCompany?.scope === scope ? loadedCompany.data : null;
  const error = loadedError?.scope === scope ? loadedError.message : null;

  function ownsScope() {
    const auth = useAppStore.getState();
    return scope.active && latestScope.current === scope && auth.sessionRevision === scope.revision && auth.tenantId === scope.tenantId;
  }
  // All existing company writes retain the initiating render's scope. Late
  // refreshes/optimistic rollbacks cannot replace data belonging to a new owner.
  function setCompany(update: any) {
    if (!ownsScope()) return;
    setLoadedCompany(previous => {
      if (!ownsScope()) return previous;
      const data = typeof update === "function" ? update(previous?.scope === scope ? previous.data : null) : update;
      return data ? { scope, data } : null;
    });
  }
  function setError(message: string | null) {
    if (!ownsScope()) return;
    setLoadedError(previous => ownsScope() ? (message === null ? null : { scope, message }) : previous);
  }
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerInput, setComposerInput] = useState("");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  // Only action feedback/latches are scoped here. Existing drafts, modal/tab
  // choices and runs state are separate from this callback/toast boundary.
  const [storedActions, setStoredActions] = useState(() => blankActions(scope));
  const actions = storedActions.scope === scope ? storedActions : blankActions(scope);
  const { composerLoading, composerError, composerResult, modelSaving, modelError, savingAutonomyId } = actions;
  function changeActions(update: (previous: ActionState) => ActionState) {
    if (!ownsScope()) return;
    setStoredActions(previous => ownsScope() ? update(previous.scope === scope ? previous : blankActions(scope)) : previous);
  }
  const setComposerError = (composerError: string | null) => changeActions(previous => ({ ...previous, composerError }));
  const setComposerResult = (composerResult: ActionState["composerResult"]) => changeActions(previous => ({ ...previous, composerResult }));
  const setModelError = (modelError: string | null) => changeActions(previous => ({ ...previous, modelError }));
  // D6 — per-agent autonomy is saved immediately on selection (no separate
  // edit/save dance). `savingAutonomyId` tracks the in-flight write.
  useEffect(() => {
    scope.active = true;
    return () => { scope.active = false; };
  }, [scope]);

  useEffect(() => {
    setCompany(null);
    setError(null);
    const owner = captureAuthSession();
    if (!hydrated || !owner.token || !companyId) return;
    let active = true;
    api.getCompany(owner.token, companyId).then(data => {
      if (active && isAuthSessionCurrent(owner) && data.id === companyId) setCompany(data);
    }).catch(e => {
      if (active && isAuthSessionCurrent(owner)) setError(e.message);
    });
    return () => { active = false; };
  }, [revision, tenantId, companyId, hydrated]);

  useEffect(() => {
    if (!token || !company || tab !== "runs") return;
    apiFetch<any[]>(`/dashboard/runs?companyId=${company.id}&limit=50`, { token })
      .then((data) => setRuns(Array.isArray(data) ? data : (data as any).runs ?? []))
      .catch(() => {});
  }, [token, company, tab]);

  const handleSaveModel = async (agentId: string) => {
    const accessToken = useAppStore.getState().token;
    if (!accessToken || !company || !ownsScope() || scope.modelRequest) return;
    const request = {};
    scope.modelRequest = request;
    const ownsRequest = () => ownsScope() && scope.modelRequest === request;
    const newModel = modelDraft.trim();
    changeActions(previous => ({ ...previous, modelSaving: true, modelError: null }));
    try {
      await api.updateAgent(accessToken, company.id, agentId, { model: newModel });
      if (!ownsRequest()) return;
      const updated = await api.getCompany(useAppStore.getState().token!, company.id);
      if (!ownsRequest()) return;
      setCompany(updated);
      setEditingAgentId(previous => ownsScope() ? null : previous);
      setModelDraft(previous => ownsScope() ? "" : previous);
      toast(t("app.companyDetail.modelUpdated", { model: newModel }), "success");
    } catch (e: any) {
      if (!ownsRequest() || e instanceof SessionChangedError) return;
      const msg = e?.message ?? t("app.companyDetail.updateModelFailed");
      setModelError(msg);
      toast(msg, "error");
    } finally {
      if (ownsRequest()) {
        scope.modelRequest = undefined;
        changeActions(previous => ({ ...previous, modelSaving: Boolean(scope.modelRequest) }));
      }
    }
  };

  const handleSetAutonomy = async (
    agentId: string,
    autonomy: "SUPERVISED" | "BALANCED" | "AUTONOMOUS",
  ) => {
    const accessToken = useAppStore.getState().token;
    if (!accessToken || !company || !ownsScope() || scope.autonomyRequest) return;
    const request = {};
    scope.autonomyRequest = request;
    const ownsRequest = () => ownsScope() && scope.autonomyRequest === request;
    changeActions(previous => ({ ...previous, savingAutonomyId: agentId }));
    // Optimistic: reflect the choice immediately, roll back on failure.
    const prev = company;
    setCompany((c: any) =>
      c
        ? { ...c, agents: c.agents?.map((a: any) => (a.id === agentId ? { ...a, autonomy } : a)) }
        : c,
    );
    try {
      await api.updateAgent(accessToken, company.id, agentId, { autonomy });
      if (!ownsRequest()) return;
      toast(t("app.autonomy.saved", { level: t(`app.autonomy.level.${autonomy}`) }), "success");
    } catch (e: any) {
      if (!ownsRequest() || e instanceof SessionChangedError) return;
      setCompany(prev); // roll back
      toast(e?.message ?? t("app.autonomy.saveFailed"), "error");
    } finally {
      if (ownsRequest()) {
        scope.autonomyRequest = undefined;
        changeActions(previous => ({ ...previous, savingAutonomyId: scope.autonomyRequest ? previous.savingAutonomyId : null }));
      }
    }
  };

  const handleCompose = async () => {
    const accessToken = useAppStore.getState().token;
    if (!accessToken || !company || !ownsScope() || scope.composerRequest) return;
    const request = {};
    scope.composerRequest = request;
    const ownsRequest = () => ownsScope() && scope.composerRequest === request;
    changeActions(previous => ({ ...previous, composerLoading: true, composerError: null, composerResult: null }));
    try {
      const res = await api.composeAgent(accessToken, company.id, composerInput);
      if (!ownsRequest()) return;
      setComposerResult({
        name: res.agent.name,
        droppedTools: res.droppedTools,
        provider: res.provider,
        model: res.model,
      });
      const updated = await api.getCompany(useAppStore.getState().token!, company.id);
      if (!ownsRequest()) return;
      setCompany(updated);
      setComposerInput(previous => ownsScope() ? "" : previous);
      toast(t("app.companyDetail.agentAdded", { name: res.agent.name }), "success");
    } catch (e: any) {
      if (!ownsRequest() || e instanceof SessionChangedError) return;
      const msg = e?.message ?? t("app.companyDetail.composerFailed");
      setComposerError(msg);
      toast(msg, "error", 6000);
    } finally {
      if (ownsRequest()) {
        scope.composerRequest = undefined;
        changeActions(previous => ({ ...previous, composerLoading: Boolean(scope.composerRequest) }));
      }
    }
  };

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }} />
    </div>
  );
  if (error) return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="bv-glass p-4 text-sm" style={{ borderColor: "rgba(255,77,77,0.25)", color: "var(--bv-status-failed)" }}>{error}</div>
    </div>
  );
  if (!company || company.id !== companyId) return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="animate-shimmer" style={{ height: 32, width: 192, borderRadius: 8 }} />
    </div>
  );

  // Status mapping → bv-dot classes
  const statusDotClass: Record<string, string> = {
    ACTIVE:   "bv-dot bv-running bv-ping",
    PAUSED:   "bv-dot bv-paused",
    ARCHIVED: "bv-dot bv-cancelled",
  };
  const statusPillClass: Record<string, string> = {
    ACTIVE:   "bv-pill bv-pill-amber",
    PAUSED:   "bv-pill bv-pill-muted",
    ARCHIVED: "bv-pill bv-pill-red",
  };
  const dotCls = statusDotClass[company.status] ?? "bv-dot bv-paused";
  const pillCls = statusPillClass[company.status] ?? "bv-pill bv-pill-muted";

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "agents",    label: t("app.companyDetail.tabAgents"),    count: company.agents?.length },
    { key: "pipelines", label: t("app.companyDetail.tabPipelines"), count: company.pipelines?.length },
    { key: "runs",      label: t("app.companyDetail.tabRuns") },
    { key: "compare",   label: t("app.compare.title") },
    { key: "contacts",  label: t("app.companyDetail.tabCrm") },
    { key: "memory",    label: t("app.companyDetail.tabMemory") },
    { key: "overview",  label: "Export" },
  ];

  const runStatusDot: Record<string, string> = {
    COMPLETED: "bv-dot bv-completed",
    FAILED:    "bv-dot bv-failed",
    RUNNING:   "bv-dot bv-running bv-ping",
    PAUSED:    "bv-dot bv-paused",
    CANCELLED: "bv-dot bv-cancelled",
  };
  const runStatusPill: Record<string, string> = {
    COMPLETED: "bv-pill bv-pill-cyan",
    FAILED:    "bv-pill bv-pill-red",
    RUNNING:   "bv-pill bv-pill-amber",
    PAUSED:    "bv-pill bv-pill-muted",
    CANCELLED: "bv-pill bv-pill-muted",
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: 1152, margin: "0 auto", padding: "32px 24px" }}>

      {/* ── Page head ── */}
      <div className="bv-page-head" style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="bv-avatar bv-avatar-lg">
            {company.name?.charAt(0)}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h1 className="bv-headline" style={{ color: "var(--color-on-surface)", margin: 0 }}>{company.name}</h1>
              <span className={pillCls} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={dotCls} />
                {company.status?.toLowerCase()}
              </span>
            </div>
            <p className="bv-caption" style={{ marginTop: 4, marginBottom: 0 }}>
              {company.description ?? ""}
              {company.agents?.length > 0 && (
                <>
                  <span className="bv-divider-dot" />
                  {company.agents.length} {t("app.companyDetail.tabAgents").toLowerCase()}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="bv-page-head-actions">
          <Link href="/companies" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ textDecoration: "none" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>arrow_back</span>
            {t("app.companyDetail.back")}
          </Link>
          <button className="bv-btn bv-btn-ghost bv-btn-sm">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>pause</span>
            Pause
          </button>
          <button className="bv-btn bv-btn-ghost bv-btn-sm">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>archive</span>
            Archive
          </button>
        </div>
      </div>

      {/* ── Primitives pills ── */}
      {company.primitives?.length > 0 && (
        <div className="bv-fpills" style={{ marginBottom: 24 }}>
          {company.primitives.map((p: string) => (
            <span key={p} className="bv-pill bv-pill-cyan">{p}</span>
          ))}
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--color-outline-variant)", marginBottom: 28 }}>
        {tabs.map((tabItem) => {
          const active = tab === tabItem.key;
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              style={{
                padding: "12px 18px",
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                borderBottom: active ? "2px solid #3B82F6" : "2px solid transparent",
                marginBottom: -1,
                background: "transparent",
                color: active ? "#E8EBF0" : "var(--color-on-surface-variant)",
                cursor: "pointer",
                transition: "color 0.2s",
                display: "flex",
                alignItems: "center",
                gap: 6,
                boxShadow: active ? "0 0 10px rgba(59,130,246,0.3)" : "none",
              }}
            >
              {tabItem.label}
              {tabItem.count !== undefined && (
                <span
                  className={active ? "bv-pill bv-pill-cyan" : "bv-pill bv-pill-muted"}
                  style={{ fontSize: 10 }}
                >
                  {tabItem.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Agents tab ── */}
      {tab === "compare" && <ComparePanel key={`${revision}:${tenantId}:${companyId}`} companyId={companyId} />}

      {tab === "agents" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <p className="bv-micro" style={{ margin: 0 }}>
              {t("app.companyDetail.agentsConfigured", { n: company.agents?.length ?? 0 })}
            </p>
            <button
              onClick={() => { setComposerOpen(true); setComposerError(null); setComposerResult(null); }}
              className="bv-btn bv-btn-primary bv-btn-sm"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_awesome</span>
              {t("app.companyDetail.composeWithAi")}
            </button>
          </div>

          <div className="bv-stagger" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))", gap: 16 }}>
            {company.agents?.map((a: any) => {
              const isExpanded = expandedAgent === a.id;
              return (
                <div
                  key={a.id}
                  onClick={() => setExpandedAgent(isExpanded ? null : a.id)}
                  className="bv-glass"
                  style={{
                    padding: "18px 20px",
                    cursor: "pointer",
                    borderColor: isExpanded ? "rgba(59,130,246,0.3)" : undefined,
                  }}
                >
                  {/* Card top */}
                  <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
                    <div
                      style={{
                        width: 34, height: 34, borderRadius: 9,
                        background: "var(--bv-gradient-brand)",
                        display: "grid", placeItems: "center",
                        flexShrink: 0,
                        color: "#fff", fontFamily: "var(--bv-font-mono)",
                        fontSize: 13, fontWeight: 600,
                        boxShadow: "0 4px 12px rgba(59,130,246,0.25)",
                      }}
                    >
                      {a.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="bv-mono" style={{ color: "var(--color-on-surface)", fontWeight: 500, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        agent:{a.name?.toLowerCase()}
                      </div>
                      <div className="bv-micro" style={{ marginTop: 2, textTransform: "none", letterSpacing: 0 }}>{a.role}</div>
                    </div>
                    <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: 16, color: "var(--color-outline)",
                        transform: isExpanded ? "rotate(180deg)" : "none",
                        transition: "transform 0.2s",
                        flexShrink: 0,
                      }}
                    >
                      expand_more
                    </span>
                  </div>

                  {/* Tool chips */}
                  {a.tools?.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {(a.tools as string[]).map((toolName) => (
                        <span key={toolName} className="bv-pill bv-pill-muted">{toolName}</span>
                      ))}
                    </div>
                  )}

                  {/* Status foot */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
                    <span className="bv-dot bv-completed" />
                    <span className="bv-micro" style={{ textTransform: "none", letterSpacing: 0 }}>
                      {t("app.companyDetail.statusActive")}
                    </span>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--color-outline-variant)" }}>
                      {a.systemPrompt && (
                        <div style={{ marginBottom: 12 }}>
                          <p className="bv-micro" style={{ marginBottom: 6 }}>SYSTEM PROMPT</p>
                          <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", background: "rgba(59,130,246,0.04)", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(59,130,246,0.1)", whiteSpace: "pre-wrap", margin: 0 }}>
                            {a.systemPrompt.length > 300 ? a.systemPrompt.slice(0, 300) + "..." : a.systemPrompt}
                          </p>
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                        <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 220 }}>
                          <p className="bv-micro" style={{ marginBottom: 4 }}>{t("app.companyDetail.colModel")}</p>
                          {editingAgentId === a.id ? (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <input
                                list={`model-options-${a.id}`}
                                value={modelDraft}
                                onChange={(e) => setModelDraft(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                disabled={modelSaving}
                                autoFocus
                                placeholder="claude-sonnet-4-5-20250929"
                                className="bv-mono"
                                style={{
                                  flex: 1, padding: "4px 8px",
                                  background: "rgba(0,0,0,0.3)", border: "1px solid rgba(59,130,246,0.3)",
                                  borderRadius: 6, color: "var(--color-on-surface)", outline: "none",
                                }}
                              />
                              <datalist id={`model-options-${a.id}`}>
                                <option value="claude-opus-4-20250514" />
                                <option value="claude-sonnet-4-5-20250929" />
                                <option value="claude-haiku-4-5-20251001" />
                                <option value="gpt-4o" />
                                <option value="gpt-4o-mini" />
                                <option value="o1-mini" />
                                <option value="gemini-1.5-pro" />
                                <option value="gemini-1.5-flash" />
                                <option value="llama-3.3-70b-versatile" />
                                <option value="mistral-large-latest" />
                                <option value="deepseek-chat" />
                                <option value="deepseek-reasoner" />
                                <option value="moonshot-v1-128k" />
                                <option value="qwen-max" />
                                <option value="gemma3:4b" />
                                <option value="gemma3:12b" />
                              </datalist>
                              <button
                                onClick={() => handleSaveModel(a.id)}
                                disabled={modelSaving || modelDraft.trim().length === 0}
                                className="bv-btn bv-btn-primary bv-btn-sm"
                              >
                                {modelSaving ? "..." : t("app.companyDetail.save")}
                              </button>
                              <button
                                onClick={() => { setEditingAgentId(null); setModelDraft(""); setModelError(null); }}
                                disabled={modelSaving}
                                className="bv-btn bv-btn-ghost bv-btn-sm"
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>{a.model ?? "default"}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditingAgentId(a.id); setModelDraft(a.model ?? ""); setModelError(null); }}
                                className="bv-btn bv-btn-ghost bv-btn-sm"
                                style={{ padding: "2px 8px", minHeight: "unset" }}
                              >
                                {t("app.companyDetail.editLabel")}
                              </button>
                            </div>
                          )}
                          {modelError && editingAgentId === a.id && (
                            <p style={{ fontSize: 10, color: "var(--bv-status-failed)", marginTop: 2 }}>{modelError}</p>
                          )}
                        </div>
                        <div>
                          <p className="bv-micro" style={{ marginBottom: 4 }}>{t("app.companyDetail.colTools")}</p>
                          <span className="bv-numeric" style={{ color: "var(--color-on-surface)", fontSize: 14 }}>{a.tools?.length ?? 0}</span>
                        </div>
                        <div>
                          <p className="bv-micro" style={{ marginBottom: 4 }}>{t("app.companyDetail.colStatus")}</p>
                          <span className="bv-pill bv-pill-cyan">{t("app.companyDetail.statusActive")}</span>
                        </div>
                      </div>

                      {/* Autonomy selector (D6) — 3-way segmented control. Saved on
                          select. Money always needs approval regardless. */}
                      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 16 }}>
                        <p className="bv-micro" style={{ marginBottom: 6 }}>{t("app.autonomy.label")}</p>
                        <AutonomySegmented
                          value={(a.autonomy ?? "BALANCED") as "SUPERVISED" | "BALANCED" | "AUTONOMOUS"}
                          disabled={savingAutonomyId !== null}
                          onChange={(level) => handleSetAutonomy(a.id, level)}
                          t={t}
                        />
                        <p
                          className="bv-caption"
                          style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#60A5FA" }}>
                            lock
                          </span>
                          {t("app.autonomy.moneyNote")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {(!company.agents || company.agents.length === 0) && (
              <p className="bv-caption" style={{ gridColumn: "span 3", textAlign: "center", padding: "48px 0" }}>
                {t.rich("app.companyDetail.noAgents", { b: (c) => <strong>{c}</strong> })}
              </p>
            )}
          </div>
        </>
      )}

      {/* ── Pipelines tab ── */}
      {tab === "pipelines" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {company.pipelines?.map((p: any) => {
            const stepCount = (p.steps as any[])?.length ?? 0;
            return (
              <div
                key={p.id}
                className="bv-glass"
                style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: 16, borderRadius: 14 }}
              >
                <span className="bv-dot bv-completed" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="bv-title" style={{ margin: 0 }}>{p.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                    <span className="bv-caption">{p.trigger}</span>
                    {p.schedule && <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 10 }}>{p.schedule}</span>}
                    <span className="bv-caption">{t("app.companyDetail.stepCount", { n: stepCount })}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    onClick={async () => {
                      if (!token) return;
                      try { await api.triggerRun(token, p.id); setTab("runs"); } catch {}
                    }}
                    className="bv-btn bv-btn-primary bv-btn-sm"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                    {t("app.companyDetail.run")}
                  </button>
                </div>
              </div>
            );
          })}
          {(!company.pipelines || company.pipelines.length === 0) && (
            <p className="bv-caption" style={{ textAlign: "center", padding: "48px 0" }}>{t("app.companyDetail.noPipelines")}</p>
          )}
        </div>
      )}

      {/* ── Runs tab ── */}
      {tab === "runs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((r: any) => {
            const dotCl = runStatusDot[r.status] ?? "bv-dot bv-paused";
            const pillCl = runStatusPill[r.status] ?? "bv-pill bv-pill-muted";
            return (
              <Link
                key={r.id}
                href={`/companies/${company.id}/runs/${r.id}`}
                className="bv-glass"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", textDecoration: "none", borderRadius: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className={dotCl} />
                  <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>{r.id.slice(0, 10)}</span>
                  <span className="bv-body" style={{ color: "var(--color-on-surface-variant)", fontWeight: 500 }}>
                    {company.pipelines?.find((p: any) => p.id === r.pipelineId)?.name ?? t("app.companyDetail.unknownPipeline")}
                  </span>
                  <span className={pillCl}>{r.status}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="bv-caption">{new Date(r.createdAt).toLocaleString()}</span>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-outline)" }}>chevron_right</span>
                </div>
              </Link>
            );
          })}
          {runs.length === 0 && (
            <p className="bv-caption" style={{ textAlign: "center", padding: "48px 0" }}>{t("app.companyDetail.noRuns")}</p>
          )}
        </div>
      )}

      {/* ── CRM / Contacts tab ── */}
      {tab === "contacts" && <DealsKanban companyId={company.id} token={token!} />}

      {/* ── Memory tab ── */}
      {tab === "memory" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {/* Candidate */}
          <div className="bv-glass bv-panel" style={{ borderRadius: 16 }}>
            <div className="bv-panel-head">
              <h4 className="bv-micro" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                <span className="bv-dot bv-running bv-ping" />
                Candidate
              </h4>
            </div>
            <MemoryChip text={t("app.companyDetail.memoryTitle")} meta={t("app.companyDetail.memoryBody")} variant="candidate" />
          </div>
          {/* Approved */}
          <div className="bv-glass bv-panel" style={{ borderRadius: 16 }}>
            <div className="bv-panel-head">
              <h4 className="bv-micro" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                <span className="bv-dot bv-completed" />
                Approved
              </h4>
            </div>
            <div className="bv-caption" style={{ textAlign: "center", padding: "24px 0", color: "var(--color-outline)" }}>No approved memory yet</div>
          </div>
          {/* Deprecated */}
          <div className="bv-glass bv-panel" style={{ borderRadius: 16 }}>
            <div className="bv-panel-head">
              <h4 className="bv-micro" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                <span className="bv-dot bv-cancelled" />
                Deprecated
              </h4>
            </div>
            <div className="bv-caption" style={{ textAlign: "center", padding: "24px 0", color: "var(--color-outline)" }}>Nothing deprecated</div>
          </div>
        </div>
      )}

      {/* ── Export tab (reusing "overview" key for the 6th tab slot) ── */}
      {tab === "overview" && (
        <div style={{ maxWidth: 620 }}>
          <div className="bv-glass bv-panel" style={{ borderRadius: 16, padding: 28 }}>
            <div className="bv-panel-head" style={{ marginBottom: 8 }}>
              <div>
                <h3 className="bv-headline" style={{ textTransform: "uppercase", margin: 0 }}>Encrypted offline bundle</h3>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", marginTop: 8, marginBottom: 0 }}>
                  Export this workspace — agents, pipelines, memory and full audit trail — as an encrypted bundle you can run fully offline.
                </p>
              </div>
            </div>

            <div className="bv-divider" style={{ margin: "16px 0" }} />

            {/* Options */}
            {[
              { label: "Agents & pipeline definitions", meta: `${company.agents?.length ?? 9} agents · ${company.pipelines?.length ?? 4} pipelines`, defaultChecked: true },
              { label: "Approved memory", meta: "candidate memory excluded", defaultChecked: true },
              { label: "Full run audit trail", meta: "+ 1,204 logged steps", defaultChecked: false },
            ].map((opt) => (
              <div key={opt.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid rgba(35,40,51,0.5)" }}>
                <input
                  type="checkbox"
                  defaultChecked={opt.defaultChecked}
                  style={{ width: 18, height: 18, accentColor: "#3B82F6", flexShrink: 0 }}
                />
                <div>
                  <div className="bv-body" style={{ color: "var(--color-on-surface)" }}>{opt.label}</div>
                  <div className="bv-mono" style={{ color: "var(--color-outline)", marginTop: 2 }}>{opt.meta}</div>
                </div>
              </div>
            ))}

            <button className="bv-btn bv-btn-primary" style={{ marginTop: 22 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>lock</span>
              Forge encrypted bundle
            </button>
          </div>
        </div>
      )}

      {/* ── AI Agent Composer Modal ── */}
      {composerOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !composerLoading) setComposerOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
          }}
        >
          <div
            className="bv-glass bv-rise"
            style={{
              maxWidth: 600, width: "100%", maxHeight: "90vh", overflow: "auto",
              padding: 24, borderRadius: 20, borderColor: "rgba(59,130,246,0.3)",
              boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="material-symbols-outlined" style={{ color: "#3B82F6", fontSize: 20 }}>auto_awesome</span>
                {t("app.companyDetail.composerTitle")}
              </h2>
              <button
                onClick={() => { if (!composerLoading) setComposerOpen(false); }}
                disabled={composerLoading}
                className="bv-btn bv-btn-ghost bv-btn-icon"
                aria-label={t("app.companyDetail.close")}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>

            <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", marginBottom: 12, lineHeight: 1.5 }}>
              {t("app.companyDetail.composerDesc")}
            </p>

            <textarea
              value={composerInput}
              onChange={(e) => setComposerInput(e.target.value)}
              placeholder={t("app.companyDetail.composerPlaceholder")}
              rows={6}
              disabled={composerLoading}
              style={{
                width: "100%", boxSizing: "border-box",
                background: "rgba(0,0,0,0.3)", border: "1px solid var(--color-outline-variant)",
                borderRadius: 10, padding: 12, color: "var(--color-on-surface)", fontSize: 13,
                fontFamily: "inherit", resize: "vertical", outline: "none",
              }}
            />
            <p className="bv-mono" style={{ color: "var(--color-outline)", marginTop: 4, marginBottom: 0 }}>
              {t("app.companyDetail.charCount", { n: composerInput.length })}
            </p>

            {composerError && (
              <div className="bv-glass" style={{ borderColor: "rgba(255,77,77,0.25)", color: "var(--bv-status-failed)", padding: 12, borderRadius: 10, fontSize: 12, marginTop: 12, whiteSpace: "pre-wrap" }}>
                {composerError}
              </div>
            )}

            {composerResult && (
              <div className="bv-glass" style={{ borderColor: "rgba(59,130,246,0.25)", color: "#3B82F6", padding: 12, borderRadius: 10, fontSize: 12, marginTop: 12 }}>
                {t.rich("app.companyDetail.agentAddedResult", { name: composerResult.name, b: (c) => <strong>{c}</strong> })}{" "}
                <span className="bv-caption" style={{ display: "inline" }}>
                  ({composerResult.provider} · {composerResult.model})
                </span>
                {composerResult.droppedTools.length > 0 && (
                  <p style={{ marginTop: 6, marginBottom: 0, color: "var(--bv-status-running)", fontSize: 11 }}>
                    {t("app.companyDetail.droppedNote", { n: composerResult.droppedTools.length, tools: composerResult.droppedTools.join(", ") })}
                  </p>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => { if (!composerLoading) setComposerOpen(false); }}
                disabled={composerLoading}
                className="bv-btn bv-btn-ghost"
              >
                {t("app.companyDetail.close")}
              </button>
              <button
                onClick={handleCompose}
                disabled={composerLoading || composerInput.trim().length < 10}
                className="bv-btn bv-btn-primary"
                style={{ opacity: composerLoading || composerInput.trim().length < 10 ? 0.5 : 1 }}
              >
                {composerLoading ? (
                  <>
                    <span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block" }} className="animate-spin" />
                    {t("app.companyDetail.composing")}
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_awesome</span>
                    {t("app.companyDetail.compose")}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub Components ─────────────────────────────────────── */

function MemoryChip({ text, meta, variant }: { text: string; meta: string; variant: "candidate" | "approved" | "deprecated" }) {
  const borderMap = { candidate: "var(--bv-status-running)", approved: "var(--bv-status-completed)", deprecated: "var(--color-outline)" };
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 11,
        background: "rgba(20,23,31,0.6)",
        border: "1px solid var(--color-outline-variant)",
        borderLeft: `2px solid ${borderMap[variant]}`,
        fontSize: 13,
        color: variant === "deprecated" ? "var(--color-outline)" : "var(--color-on-surface)",
        lineHeight: 1.4,
        textDecoration: variant === "deprecated" ? "line-through" : "none",
        textDecorationColor: "var(--color-outline)",
      }}
    >
      {text}
      <span
        className="bv-mono"
        style={{ display: "block", marginTop: 5, textDecoration: "none", color: "var(--color-outline)" }}
      >
        {meta}
      </span>
    </div>
  );
}

function StatBox({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  const iconMap: Record<string, string> = {
    agent:    "group",
    pipeline: "account_tree",
    date:     "calendar_today",
  };
  return (
    <div className="bv-glass bv-metric" style={{ borderRadius: 16, position: "relative" }}>
      <div className="bv-metric-accent" style={{ background: "var(--bv-gradient-brand)" }} />
      <div className="bv-metric-head">
        <div className="bv-metric-icon">
          <span className="material-symbols-outlined">{iconMap[icon] ?? "circle"}</span>
        </div>
      </div>
      <div className="bv-metric-value">
        <span className="bv-numeric" style={{ fontSize: 28 }}>{value}</span>
      </div>
      <p className="bv-metric-foot">{label}</p>
    </div>
  );
}

const DEAL_STAGES = [
  { key: "LEAD",           lkey: "Lead",        accentClass: "bv-pill-muted" },
  { key: "QUALIFIED",      lkey: "Qualified",   accentClass: "bv-pill-cyan" },
  { key: "PROPOSAL_SENT",  lkey: "Proposal",    accentClass: "bv-pill-amber" },
  { key: "NEGOTIATION",    lkey: "Negotiation", accentClass: "bv-pill-amber" },
  { key: "CLOSED_WON",     lkey: "Won",         accentClass: "bv-pill-cyan" },
  { key: "CLOSED_LOST",    lkey: "Lost",        accentClass: "bv-pill-red" },
];

function DealsKanban({ companyId, token }: { companyId: string; token: string }) {
  const t = useTranslations();
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

  if (loading) return <div className="animate-shimmer" style={{ height: 192, borderRadius: 16 }} />;

  const dealsByStage = DEAL_STAGES.map((stage) => ({
    ...stage,
    deals: deals.filter((d) => d.stage === stage.key),
  }));

  return (
    <div>
      {/* Contacts */}
      <div style={{ marginBottom: 24 }}>
        <h3 className="bv-micro" style={{ marginBottom: 12 }}>
          {t("app.companyDetail.contactsTitle", { n: contacts.length })}
        </h3>
        {contacts.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {contacts.slice(0, 10).map((c: any) => (
              <div key={c.id} className="bv-glass" style={{ padding: "8px 12px", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  className="bv-avatar"
                  style={{ width: 24, height: 24, borderRadius: "50%", fontSize: 10, flexShrink: 0 }}
                >
                  {c.name?.charAt(0)?.toUpperCase() ?? "?"}
                </div>
                <span className="bv-body" style={{ color: "var(--color-on-surface-variant)", fontWeight: 500 }}>{c.name}</span>
                <span className="bv-caption">{c.email}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="bv-caption" style={{ color: "var(--color-outline)" }}>{t("app.companyDetail.noContacts")}</p>
        )}
      </div>

      {/* Kanban */}
      <h3 className="bv-micro" style={{ marginBottom: 12 }}>{t("app.companyDetail.dealPipeline")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, overflowX: "auto" }}>
        {dealsByStage.map((stage) => (
          <div
            key={stage.key}
            className="bv-glass"
            style={{ padding: 12, minHeight: 180, borderRadius: 12 }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h4 className="bv-micro" style={{ margin: 0 }}>{t(`app.companyDetail.dealStage${stage.lkey}`)}</h4>
              <span className={`bv-pill ${stage.accentClass}`} style={{ fontSize: 10 }}>{stage.deals.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {stage.deals.map((deal: any) => (
                <div
                  key={deal.id}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 8,
                    padding: 10,
                    border: "1px solid var(--color-outline-variant)",
                  }}
                >
                  <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", fontWeight: 500, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{deal.title}</p>
                  {deal.valueUsd > 0 && (
                    <p className="bv-numeric" style={{ color: "#3B82F6", fontSize: 11, marginTop: 4, marginBottom: 0 }}>${deal.valueUsd}</p>
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

/* ── Autonomy segmented control (D6 — Relevance's signature) ────────────────
 * Three levels of how eagerly an agent pauses for approval on NON-money tools.
 * Money-touching actions always need approval (rule #3), surfaced in the note
 * beneath this control. Saved immediately on click. */
const AUTONOMY_LEVELS = ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const;
const AUTONOMY_ICON: Record<(typeof AUTONOMY_LEVELS)[number], string> = {
  SUPERVISED: "visibility",
  BALANCED: "balance",
  AUTONOMOUS: "rocket_launch",
};

function AutonomySegmented({
  value,
  disabled,
  onChange,
  t,
}: {
  value: (typeof AUTONOMY_LEVELS)[number];
  disabled: boolean;
  onChange: (level: (typeof AUTONOMY_LEVELS)[number]) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div>
      <div
        role="radiogroup"
        aria-label={t("app.autonomy.label")}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 4,
          padding: 4,
          background: "rgba(0,0,0,0.25)",
          border: "1px solid var(--bv-glass-border)",
          borderRadius: 12,
          maxWidth: 420,
        }}
      >
        {AUTONOMY_LEVELS.map((level) => {
          const active = value === level;
          return (
            <button
              key={level}
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => !active && onChange(level)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                padding: "8px 6px",
                borderRadius: 9,
                border: active ? "1px solid rgba(59,130,246,0.4)" : "1px solid transparent",
                background: active ? "rgba(59,130,246,0.14)" : "transparent",
                color: active ? "#60A5FA" : "var(--color-on-surface-variant)",
                cursor: disabled ? "default" : active ? "default" : "pointer",
                opacity: disabled ? 0.6 : 1,
                transition: "all 0.18s",
                fontFamily: "inherit",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                {AUTONOMY_ICON[level]}
              </span>
              <span style={{ fontSize: 12, fontWeight: active ? 600 : 400 }}>
                {t(`app.autonomy.level.${level}`)}
              </span>
            </button>
          );
        })}
      </div>
      {/* One-line explainer for the active level */}
      <p className="bv-caption" style={{ marginTop: 6, lineHeight: 1.45 }}>
        {t(`app.autonomy.desc.${value}`)}
      </p>
    </div>
  );
}
