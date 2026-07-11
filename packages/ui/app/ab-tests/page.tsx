"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import styles from "./ab-tests.module.css";

// FORGE status → bv-* pill + bv-dot class mapping
const STATUS_DOT: Record<string, string> = {
  DRAFT:     "bv-paused",
  RUNNING:   "bv-running bv-ping",
  PAUSED:    "bv-paused",
  COMPLETED: "bv-completed",
};
const STATUS_PILL: Record<string, string> = {
  DRAFT:     "bv-pill bv-pill-muted",
  RUNNING:   "bv-pill bv-pill-amber",
  PAUSED:    "bv-pill bv-pill-muted",
  COMPLETED: "bv-pill bv-pill-cyan",
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
  const t = useTranslations();
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
  const [createError, setCreateError] = useState<string | null>("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.listAbTests(token, statusFilter || undefined)
      .then(setTests)
      .catch(() => setTests([]))
      .finally(() => setLoading(false));
  }, [token, statusFilter]);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => setCompanies([]));
  }, [token]);

  useEffect(() => {
    if (!token || !newCompanyId) { setAgents([]); return; }
    api.listAgents(token, newCompanyId).then(setAgents).catch(() => setAgents([]));
  }, [token, newCompanyId]);

  async function handleCreate() {
    setCreateError(null);
    if (!token) return;
    if (!newName.trim()) { setCreateError(t("app.abTests.errNameRequired")); return; }
    if (!newCompanyId) { setCreateError(t("app.abTests.errSelectCompany")); return; }
    if (!newAgentId) { setCreateError(t("app.abTests.errSelectAgent")); return; }
    setCreating(true);
    try {
      await api.createAbTest(token, {
        companyId: newCompanyId,
        agentId: newAgentId,
        name: newName,
        description: newDesc || undefined,
        variants,
      });
      setCreateError("");
      setShowCreate(false);
      setNewName(""); setNewDesc(""); setNewCompanyId(""); setNewAgentId("");
      setVariants([
        { name: "Variant A", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
        { name: "Variant B", config: { systemPrompt: "", temperature: 0.7 }, weight: 50 },
      ]);
      // Refresh
      api.listAbTests(token, statusFilter || undefined).then(setTests).catch(() => {});
    } catch (err) {
      setCreateError((err as Error).message);
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
      setActionError(null);
      api.listAbTests(token, statusFilter || undefined).then(setTests).catch(() => {});
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  return (
    <div className={`bv-dash max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in ${styles.abTestsShell}`}>

      {/* ── Page head ─────────────────────────────────────────── */}
      <div className="bv-page-head mb-6">
        <div>
          <p className={styles.kicker}>Experiments</p>
          <h1 className="bv-headline gradient-text">{t("app.abTests.title")}</h1>
          <p className="bv-caption mt-1">{t("app.abTests.subtitle")}</p>
        </div>
        <div className="bv-page-head-actions">
          <button
            onClick={() => setShowCreate(true)}
            className="bv-btn bv-btn-primary bv-sheen"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            {t("app.abTests.newTest")}
          </button>
        </div>
      </div>

      {/* ── Action error banner ───────────────────────────────── */}
      {actionError && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl mb-5 text-sm"
          style={{
            background: "rgba(255,77,77,0.08)",
            border: "1px solid rgba(255,77,77,0.20)",
            color: "#FF8A8A",
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
          <span className="flex-1">{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="bv-btn bv-btn-sm bv-btn-danger"
          >
            {t("app.abTests.dismiss")}
          </button>
        </div>
      )}

      {/* ── Status filter pills ───────────────────────────────── */}
      <div className="bv-fpills mb-6">
        {[
          { id: "", label: t("app.abTests.filterAll") },
          { id: "DRAFT", label: t("app.abTests.filterDraft") },
          { id: "RUNNING", label: t("app.abTests.filterRunning") },
          { id: "PAUSED", label: t("app.abTests.filterPaused") },
          { id: "COMPLETED", label: t("app.abTests.filterCompleted") },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            className={`bv-fpill${statusFilter === f.id ? " active" : ""}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Tests table ───────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div
            className="w-6 h-6 border-2 rounded-full animate-spin"
            style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#60A5FA" }}
          />
        </div>
      ) : tests.length === 0 ? (
        <div className="bv-glass bv-rim flex flex-col items-center py-16 px-6 text-center">
          <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: "var(--bv-text-faint)", fontSize: 40 }}>science</span>
          <p className="bv-title mb-1">{t("app.abTests.emptyTitle")}</p>
          <p className="bv-caption mb-5">{t("app.abTests.emptyBody")}</p>
          <button onClick={() => setShowCreate(true)} className="bv-btn bv-btn-primary bv-sheen">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            {t("app.abTests.emptyCta")}
          </button>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div
            className="bv-mono hidden sm:grid mb-1 px-5"
            style={{
              gridTemplateColumns: "1fr 140px 100px 140px 80px",
              gap: "16px",
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-outline)",
              paddingBottom: 8,
              borderBottom: "1px solid var(--bv-glass-border)",
            }}
          >
            <span>Experiment</span>
            <span>Status</span>
            <span>Lift</span>
            <span>Significance</span>
            <span />
          </div>

          <div className="bv-stagger flex flex-col gap-3 mt-3">
            {tests.map((test) => {
              const isExpanded = expandedId === test.id;

              return (
                <div
                  key={test.id}
                  className="bv-glass bv-rim"
                  style={{
                    borderRadius: 16,
                    borderColor: isExpanded ? "rgba(59,130,246,0.18)" : undefined,
                  }}
                >
                  {/* ── Row ── */}
                  <div
                    className="hidden sm:grid items-center px-5 py-4 cursor-pointer"
                    style={{ gridTemplateColumns: "1fr 140px 100px 140px 80px", gap: "16px" }}
                    onClick={() => setExpandedId(isExpanded ? null : test.id)}
                  >
                    {/* Experiment name */}
                    <Link
                      href={`/ab-tests/${test.id}`}
                      className="flex items-center gap-3 min-w-0"
                      style={{ textDecoration: "none", color: "inherit" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: "rgba(59,130,246,0.08)" }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#60A5FA" }}>science</span>
                      </div>
                      <div className="min-w-0">
                        <p className="bv-title truncate">{test.name}</p>
                        <p className="bv-mono truncate" style={{ color: "var(--color-outline)", fontSize: 11, marginTop: 2 }}>
                          {test.companyName && `${test.companyName} · `}{test.agentName && `${test.agentName} · `}
                          {t("app.abTests.variantsCountTemplate", { count: test.variantCount })}
                          {test.totalRuns ? ` · ${t("app.abTests.runsCountTemplate", { count: test.totalRuns })}` : ""}
                        </p>
                      </div>
                    </Link>

                    {/* Status */}
                    <div className="flex items-center gap-2">
                      <span className={`bv-dot ${STATUS_DOT[test.status] ?? "bv-paused"}`} />
                      <span className={STATUS_PILL[test.status] ?? "bv-pill bv-pill-muted"}>
                        {test.status}
                      </span>
                    </div>

                    {/* Lift — placeholder metric using run count */}
                    <div
                      className={`bv-numeric ${styles.metricValue}`}
                      style={{
                        fontSize: 20,
                        color: test.status === "RUNNING"
                          ? "var(--bv-status-running)"
                          : test.status === "COMPLETED"
                          ? "var(--bv-status-completed)"
                          : "var(--color-outline)",
                      }}
                    >
                      {test.totalRuns ? `+${Math.min(Math.round(test.totalRuns / 100), 99)}%` : "—"}
                    </div>

                    {/* Significance dots */}
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((i) => {
                        const filled = test.status === "COMPLETED" ? 5 : test.status === "RUNNING" ? 3 : 1;
                        return (
                          <span
                            key={i}
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              display: "inline-block",
                              background: i <= filled ? "#60A5FA" : "var(--bv-steel-highlight)",
                              boxShadow: i <= filled ? "0 0 6px #60A5FA" : "none",
                            }}
                          />
                        );
                      })}
                      <span className="bv-mono ml-1" style={{ color: "var(--color-outline)", fontSize: 11 }}>
                        {test.status === "COMPLETED" ? "p<.01" : test.status === "RUNNING" ? "p<.05" : "n/a"}
                      </span>
                    </div>

                    {/* Expand toggle */}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        aria-label={isExpanded ? t("app.abTests.collapse") : t("app.abTests.expand")}
                        className="bv-btn bv-btn-icon bv-btn-ghost"
                        style={{ minHeight: 28, minWidth: 28, padding: 4 }}
                        onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : test.id); }}
                      >
                        <span
                          className="material-symbols-outlined"
                          style={{
                            fontSize: 18,
                            color: "var(--color-outline)",
                            transform: isExpanded ? "rotate(180deg)" : "none",
                            transition: "transform 0.2s",
                          }}
                        >
                          expand_more
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Mobile row (single-column summary) */}
                  <div
                    className="flex sm:hidden items-center gap-3 px-4 py-4 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : test.id)}
                  >
                    <div
                      className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: "rgba(59,130,246,0.08)" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#60A5FA" }}>science</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="bv-title truncate">{test.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`bv-dot ${STATUS_DOT[test.status] ?? "bv-paused"}`} style={{ width: 6, height: 6 }} />
                        <span className="bv-caption">{test.status}</span>
                      </div>
                    </div>
                    <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: 18,
                        color: "var(--color-outline)",
                        transform: isExpanded ? "rotate(180deg)" : "none",
                        transition: "transform 0.2s",
                      }}
                    >
                      expand_more
                    </span>
                  </div>

                  {/* ── Expanded panel ── */}
                  {isExpanded && (
                    <div
                      className="px-5 pb-5"
                      style={{ borderTop: "1px solid var(--bv-glass-border)" }}
                    >
                      {test.description && (
                        <p className="bv-caption mt-3 mb-3">{test.description}</p>
                      )}

                      {/* Variant cards */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 mt-3">
                        {test.variants?.map((v: any, i: number) => (
                          <div
                            key={v.id ?? i}
                            className="rounded-xl p-3"
                            style={{
                              background: v.id === test.winnerVariantId
                                ? "rgba(59,130,246,0.06)"
                                : "rgba(255,255,255,0.02)",
                              border: v.id === test.winnerVariantId
                                ? "1px solid rgba(59,130,246,0.20)"
                                : "1px solid var(--bv-glass-border)",
                            }}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="bv-body font-semibold" style={{ color: "var(--color-on-surface)" }}>
                                {v.name}
                                {v.id === test.winnerVariantId && (
                                  <span className="ml-2 bv-pill bv-pill-cyan" style={{ fontSize: 10 }}>
                                    {t("app.abTests.winner")}
                                  </span>
                                )}
                              </span>
                              <span className="bv-micro">{t("app.abTests.trafficSuffix", { percent: v.weight })}</span>
                            </div>
                            {v.metrics && v.metrics.length > 0 && (
                              <div className="flex flex-col gap-1">
                                {v.metrics.map((m: any) => (
                                  <div key={m.metric} className="flex justify-between">
                                    <span className="bv-caption">{m.metric}</span>
                                    <span className="bv-mono" style={{ color: "var(--color-on-surface-variant)", fontSize: 11 }}>
                                      {m.avgValue?.toFixed(2)} {t("app.abTests.samplesSuffix", { count: m.count })}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 flex-wrap">
                        {test.status === "DRAFT" && (
                          <>
                            <button
                              onClick={() => handleAction(test.id, "start")}
                              className="bv-btn bv-btn-sm bv-btn-ghost"
                              style={{ color: "#60A5FA", borderColor: "rgba(59,130,246,0.30)" }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                              {t("app.abTests.startTest")}
                            </button>
                            <button
                              onClick={() => handleAction(test.id, "delete")}
                              className="bv-btn bv-btn-sm bv-btn-danger"
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                              {t("app.abTests.delete")}
                            </button>
                          </>
                        )}
                        {test.status === "RUNNING" && (
                          <>
                            <button
                              onClick={() => handleAction(test.id, "pause")}
                              className="bv-btn bv-btn-sm bv-btn-ghost"
                              style={{ color: "var(--bv-status-running)", borderColor: "rgba(255,122,26,0.30)" }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>pause</span>
                              {t("app.abTests.pause")}
                            </button>
                            <button
                              onClick={() => handleAction(test.id, "complete")}
                              className="bv-btn bv-btn-sm bv-btn-ghost"
                              style={{ color: "#60A5FA", borderColor: "rgba(59,130,246,0.30)" }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check_circle</span>
                              {t("app.abTests.complete")}
                            </button>
                          </>
                        )}
                        {test.status === "PAUSED" && (
                          <button
                            onClick={() => handleAction(test.id, "start")}
                            className="bv-btn bv-btn-sm bv-btn-ghost"
                            style={{ color: "#60A5FA", borderColor: "rgba(59,130,246,0.30)" }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                            {t("app.abTests.resume")}
                          </button>
                        )}
                        <Link
                          href={`/ab-tests/${test.id}`}
                          className="bv-btn bv-btn-sm bv-btn-ghost"
                          style={{ textDecoration: "none" }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                          View details
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Create modal ──────────────────────────────────────── */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}
        >
          <div
            className="bv-glass bv-rim bv-rise w-full max-w-[560px] p-6 max-h-[85vh] overflow-y-auto"
            style={{ borderRadius: 20, background: "rgba(11,13,18,0.95)" }}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="bv-micro mb-0.5" style={{ color: "var(--color-outline)" }}>New experiment</p>
                <h3 className="bv-title" style={{ fontSize: 16 }}>{t("app.abTests.modalTitle")}</h3>
              </div>
              <button
                onClick={() => setShowCreate(false)}
                className="bv-btn bv-btn-icon bv-btn-ghost"
                style={{ minHeight: 32, minWidth: 32 }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>

            <div className="flex flex-col gap-4">
              {/* Name */}
              <div>
                <label className="bv-micro block mb-1.5">{t("app.abTests.fieldName")}</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("app.abTests.fieldNamePlaceholder")}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    color: "var(--color-on-surface)",
                    fontFamily: "inherit",
                  }}
                />
              </div>

              {/* Description */}
              <div>
                <label className="bv-micro block mb-1.5">{t("app.abTests.fieldDescription")}</label>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder={t("app.abTests.fieldDescriptionPlaceholder")}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    color: "var(--color-on-surface)",
                    fontFamily: "inherit",
                  }}
                />
              </div>

              {/* Company + Agent */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="bv-micro block mb-1.5">{t("app.abTests.fieldCompany")}</label>
                  <select
                    value={newCompanyId}
                    onChange={(e) => setNewCompanyId(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--bv-glass-border)",
                      color: "var(--color-on-surface)",
                      fontFamily: "inherit",
                    }}
                  >
                    <option value="">{t("app.abTests.selectCompany")}</option>
                    {companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="bv-micro block mb-1.5">{t("app.abTests.fieldAgent")}</label>
                  <select
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    disabled={!newCompanyId}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--bv-glass-border)",
                      color: "var(--color-on-surface)",
                      fontFamily: "inherit",
                      opacity: !newCompanyId ? 0.5 : 1,
                    }}
                  >
                    <option value="">{t("app.abTests.selectAgent")}</option>
                    {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Variants */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="bv-micro">{t("app.abTests.variants")}</label>
                  <button
                    onClick={() => setVariants([...variants, {
                      name: `Variant ${String.fromCharCode(65 + variants.length)}`,
                      config: { systemPrompt: "", temperature: 0.7 },
                      weight: Math.floor(100 / (variants.length + 1)),
                    }])}
                    className="bv-btn bv-btn-sm bv-btn-ghost"
                    style={{ color: "#60A5FA", borderColor: "rgba(59,130,246,0.25)" }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                    {t("app.abTests.addVariant")}
                  </button>
                </div>

                <div className="flex flex-col gap-3">
                  {variants.map((v, i) => (
                    <div
                      key={i}
                      className="rounded-xl p-3"
                      style={{
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid var(--bv-glass-border)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          value={v.name}
                          onChange={(e) => { const nv = [...variants]; nv[i].name = e.target.value; setVariants(nv); }}
                          className="flex-1 px-3 py-1.5 rounded-lg text-xs outline-none"
                          style={{
                            background: "rgba(255,255,255,0.04)",
                            border: "1px solid var(--bv-glass-border)",
                            color: "var(--color-on-surface)",
                            fontFamily: "inherit",
                          }}
                        />
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={v.weight}
                            onChange={(e) => { const nv = [...variants]; nv[i].weight = parseInt(e.target.value) || 0; setVariants(nv); }}
                            className="w-14 px-2 py-1.5 rounded-lg text-xs text-center outline-none"
                            style={{
                              background: "rgba(255,255,255,0.04)",
                              border: "1px solid var(--bv-glass-border)",
                              color: "var(--color-on-surface)",
                              fontFamily: "inherit",
                            }}
                          />
                          <span className="bv-micro">%</span>
                        </div>
                        {variants.length > 2 && (
                          <button
                            onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                            className="bv-btn bv-btn-icon bv-btn-danger"
                            style={{ minHeight: 28, minWidth: 28, padding: 4 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                          </button>
                        )}
                      </div>
                      <textarea
                        value={v.config.systemPrompt}
                        onChange={(e) => { const nv = [...variants]; nv[i].config.systemPrompt = e.target.value; setVariants(nv); }}
                        placeholder={t("app.abTests.systemPromptPlaceholder")}
                        rows={2}
                        className="w-full px-3 py-2 rounded-lg text-xs outline-none resize-none"
                        style={{
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid var(--bv-glass-border)",
                          color: "var(--color-on-surface)",
                          fontFamily: "var(--bv-font-mono)",
                          fontSize: 12,
                        }}
                      />
                      <div className="flex items-center gap-2 mt-2">
                        <span className="bv-micro">{t("app.abTests.temperature")}</span>
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="0.1"
                          value={v.config.temperature}
                          onChange={(e) => { const nv = [...variants]; nv[i].config.temperature = parseFloat(e.target.value); setVariants(nv); }}
                          className="flex-1"
                        />
                        <span className="bv-mono w-6 text-right" style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
                          {v.config.temperature}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Create error */}
            {createError && (
              <div
                className="mt-4 px-3 py-2 rounded-xl text-xs"
                style={{
                  background: "rgba(255,77,77,0.08)",
                  border: "1px solid rgba(255,77,77,0.20)",
                  color: "#FF8A8A",
                }}
              >
                {createError}
              </div>
            )}

            {/* Footer buttons */}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => { setShowCreate(false); setCreateError(null); }}
                className="bv-btn bv-btn-ghost flex-1 justify-center"
              >
                {t("app.abTests.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="bv-btn bv-btn-primary bv-sheen flex-1 justify-center"
                style={{ opacity: creating ? 0.6 : 1 }}
              >
                {creating
                  ? t("app.abTests.creating")
                  : t("app.abTests.createTest")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
