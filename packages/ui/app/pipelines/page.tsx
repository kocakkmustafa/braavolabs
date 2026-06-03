"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { timeAgo } from "../../lib/timeAgo";

const TRIGGER_ICONS: Record<string, string> = {
  manual: "touch_app",
  cron: "schedule",
  webhook: "webhook",
  event: "bolt",
};

function statusDotClass(status: string): string {
  if (status === "active")   return "bv-dot bv-running bv-ping";
  if (status === "paused")   return "bv-dot bv-paused";
  if (status === "disabled") return "bv-dot bv-cancelled";
  return "bv-dot bv-paused";
}

function statusPillClass(status: string): string {
  if (status === "active")   return "bv-pill bv-pill-amber";
  if (status === "paused")   return "bv-pill bv-pill-muted";
  if (status === "disabled") return "bv-pill bv-pill-muted";
  return "bv-pill bv-pill-muted";
}

function lastRunDotClass(runStatus: string): string {
  if (runStatus === "COMPLETED") return "bv-dot bv-completed";
  if (runStatus === "FAILED")    return "bv-dot bv-failed";
  return "bv-dot bv-pending";
}

/** Mini pipeline flow — squares connected by lines, lit = active step */
function MiniFlow({ steps, active }: { steps: number; active: number }) {
  return (
    <div className="flex items-center gap-0" style={{ margin: "14px 0 18px" }}>
      {Array.from({ length: steps }).map((_, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && (
            <span
              style={{
                display: "inline-block",
                width: 16,
                height: 2,
                background: "var(--bv-steel-mid)",
              }}
            />
          )}
          <span
            style={{
              display: "inline-block",
              width: 11,
              height: 11,
              borderRadius: 3,
              background: i < active
                ? "var(--bv-cobalt-glow)"
                : "var(--bv-steel-highlight)",
              boxShadow: i < active
                ? "0 0 7px var(--bv-cobalt-glow)"
                : undefined,
              flexShrink: 0,
            }}
          />
        </span>
      ))}
    </div>
  );
}

export default function PipelinesPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCompany, setFilterCompany] = useState<string>("all");
  const [triggerLoading, setTriggerLoading] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [createCompanyId, setCreateCompanyId] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    Promise.all([
      api.listCompanies(token).catch(() => []),
      api.listPipelines(token).catch(() => []),
    ]).then(([comps, pipes]) => {
      setCompanies(comps);
      setPipelines(pipes);
      setLoading(false);
    });
  }, [token, hydrated]);

  async function handleTrigger(pipelineId: string) {
    if (!token) return;
    setTriggerLoading(pipelineId);
    try {
      await api.triggerRun(token, pipelineId);
      const updated = await api.listPipelines(token).catch(() => []);
      setPipelines(updated);
    } catch {
      // silently handle
    }
    setTriggerLoading(null);
  }

  function openCreate() {
    setCreateErr(null);
    setCreateDesc("");
    setCreateCompanyId(companies[0]?.id ?? "");
    setShowCreate(true);
  }

  async function handleCreatePipeline() {
    if (!token || !createCompanyId || createDesc.trim().length < 10) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await api.createPipelineFromNL(token, createCompanyId, createDesc.trim());
      setShowCreate(false);
      if (res?.pipeline?.id) router.push(`/pipelines/${res.pipeline.id}`);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "Failed to create pipeline");
    } finally {
      setCreating(false);
    }
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div
        className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "var(--bv-cobalt-glow)" }}
      />
    </div>
  );

  const filtered = pipelines.filter((p) => {
    if (filterCompany !== "all" && p.companyId !== filterCompany) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const stats = {
    total: pipelines.length,
    active: pipelines.filter((p) => p.status === "active").length,
    scheduled: pipelines.filter((p) => p.schedule).length,
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      {/* ── Page head ── */}
      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro mb-1" style={{ color: "var(--bv-steel-mid)" }}>Pipelines</p>
          <h1 className="bv-headline" style={{ color: "var(--color-on-surface)" }}>
            {t("app.pipelines.title")}
          </h1>
          <p className="bv-caption mt-1">{t("app.pipelines.subtitle")}</p>
        </div>
        <div className="bv-page-head-actions">
          <button onClick={openCreate} className="bv-btn bv-btn-ghost bv-btn-sm">
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>auto_awesome</span>
            {t("app.pipelines.nlButton")}
          </button>
          <Link href="/companies/new" className="bv-btn bv-btn-primary bv-btn-sm bv-sheen">
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>add</span>
            {t("app.pipelines.newCompany")}
          </Link>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-3 gap-3 mb-6 bv-stagger">
        {[
          { label: t("app.pipelines.statTotal"),     value: stats.total,     icon: "account_tree", accentColor: "var(--bv-cobalt-glow)" },
          { label: t("app.pipelines.statActive"),    value: stats.active,    icon: "play_circle",  accentColor: "var(--bv-status-running)" },
          { label: t("app.pipelines.statScheduled"), value: stats.scheduled, icon: "schedule",     accentColor: "var(--bv-status-paused)" },
        ].map((s) => (
          <div key={s.label} className="bv-glass bv-metric" style={{ position: "relative" }}>
            <div
              className="bv-metric-accent"
              style={{ background: s.accentColor }}
            />
            <div className="bv-metric-head">
              <div className="bv-metric-icon">
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: s.accentColor }}>
                  {s.icon}
                </span>
              </div>
              <span className="bv-caption">{s.label}</span>
            </div>
            <span className="bv-numeric" style={{ fontSize: 24, color: "var(--color-on-surface)" }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <span
            className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2"
            style={{ fontSize: 18, color: "var(--bv-steel-mid)" }}
          >
            search
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("app.pipelines.searchPlaceholder")}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--bv-glass-border)",
              color: "var(--color-on-surface)",
              fontFamily: "var(--bv-font-body)",
            }}
          />
        </div>
        <select
          value={filterCompany}
          onChange={(e) => setFilterCompany(e.target.value)}
          className="px-4 py-2.5 rounded-xl text-sm outline-none"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid var(--bv-glass-border)",
            color: "var(--color-on-surface)",
            fontFamily: "var(--bv-font-body)",
          }}
        >
          <option value="all">{t("app.pipelines.allCompanies")}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* ── Pipeline cards grid ── */}
      {loading ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 18,
          }}
        >
          {[1, 2, 3].map((i) => (
            <div key={i} className="bv-glass animate-shimmer" style={{ height: 180 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bv-glass text-center py-16">
          <span
            className="material-symbols-outlined text-4xl mb-4 block"
            style={{ color: "var(--bv-cobalt-glow)" }}
          >
            account_tree
          </span>
          <p className="bv-title mb-1">
            {pipelines.length === 0 ? t("app.pipelines.emptyTitle") : t("app.pipelines.emptyMatchTitle")}
          </p>
          <p className="bv-caption">
            {pipelines.length === 0 ? t("app.pipelines.emptyBody") : t("app.pipelines.emptyMatchBody")}
          </p>
          {pipelines.length === 0 && (
            <Link href="/companies/new" className="bv-btn bv-btn-primary bv-sheen mt-5">
              {t("app.pipelines.createCompany")}
            </Link>
          )}
        </div>
      ) : (
        <div
          className="bv-stagger"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 18,
          }}
        >
          {filtered.map((pipeline) => {
            const trigger = pipeline.trigger ?? "manual";
            const companyName = companies.find((c) => c.id === pipeline.companyId)?.name ?? "—";
            const lastRun = pipeline.runs?.[0];
            const stepCount = pipeline.steps?.length ?? 0;
            const activeSteps = pipeline.status === "active" ? stepCount : 0;

            return (
              <div
                key={pipeline.id}
                className="bv-glass"
                style={{ padding: 22, cursor: "pointer" }}
                onClick={() => router.push(`/pipelines/${pipeline.id}`)}
              >
                {/* Card top: status dot + name + menu */}
                <div className="flex items-center gap-3 mb-2">
                  <span className={statusDotClass(pipeline.status ?? "disabled")} />
                  <span
                    className="flex-1 truncate"
                    style={{
                      fontFamily: "var(--bv-font-display)",
                      fontSize: 18,
                      fontWeight: 600,
                      letterSpacing: "-0.005em",
                      color: "var(--color-on-surface)",
                    }}
                  >
                    {pipeline.name}
                  </span>
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 20, color: "var(--color-on-surface-variant)", marginLeft: "auto" }}
                  >
                    more_horiz
                  </span>
                </div>

                {/* Meta line */}
                <p
                  className="bv-mono"
                  style={{ color: "var(--color-on-surface-variant)", marginBottom: 0 }}
                >
                  {stepCount} steps
                  {lastRun ? ` · last run ${timeAgo(lastRun.createdAt)}` : ""}
                  {" · "}
                  <span style={{ color: "var(--color-outline)" }}>{companyName}</span>
                </p>

                {/* Mini flow diagram */}
                <MiniFlow steps={Math.max(stepCount, 1)} active={activeSteps} />

                {/* Footer: schedule + actions */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 13, color: "var(--bv-steel-mid)" }}
                    >
                      {TRIGGER_ICONS[trigger] ?? "touch_app"}
                    </span>
                    <span
                      className="bv-mono truncate"
                      style={{ color: "var(--bv-steel-mid)", fontSize: 11 }}
                    >
                      {trigger === "cron" && pipeline.schedule ? pipeline.schedule : trigger}
                    </span>
                    {lastRun && (
                      <>
                        <span className="bv-divider-dot" />
                        <span className={lastRunDotClass(lastRun.status)} style={{ width: 6, height: 6 }} />
                      </>
                    )}
                    {pipeline.status && (
                      <span className={statusPillClass(pipeline.status)} style={{ marginLeft: 4 }}>
                        {pipeline.status}
                      </span>
                    )}
                  </div>

                  <Link
                    href={`/pipelines/${pipeline.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="bv-btn bv-btn-ghost bv-btn-sm"
                  >
                    {t("app.pipelines.detailButton")}
                  </Link>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleTrigger(pipeline.id); }}
                    disabled={triggerLoading === pipeline.id}
                    className="bv-btn bv-btn-primary bv-btn-sm bv-sheen"
                    style={{ minWidth: 60 }}
                  >
                    {triggerLoading === pipeline.id ? (
                      <span
                        className="inline-block w-3 h-3 border-2 rounded-full animate-spin"
                        style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }}
                      />
                    ) : (
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                    )}
                    {t("app.pipelines.runButton")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Create pipeline modal ── */}
      {showCreate && (
        <div
          onClick={() => !creating && setShowCreate(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
        >
          <div
            className="bv-glass bv-rise"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 440, padding: 24 }}
          >
            {/* Modal header */}
            <div className="flex items-center gap-3 mb-4">
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "rgba(59,130,246,0.10)",
                  border: "1px solid rgba(59,130,246,0.20)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 18, color: "var(--bv-cobalt-glow)" }}
                >
                  auto_awesome
                </span>
              </div>
              <div>
                <p className="bv-micro" style={{ color: "var(--bv-steel-mid)" }}>AI Builder</p>
                <h2 className="bv-title">{t("app.pipelines.nlTitle")}</h2>
              </div>
              <button
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="bv-btn bv-btn-ghost bv-btn-icon"
                style={{ marginLeft: "auto" }}
                aria-label="Close"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>

            <div className="bv-divider mb-4" />

            {companies.length === 0 ? (
              <p className="bv-body" style={{ color: "var(--bv-status-running)" }}>
                {t("app.pipelines.nlNeedCompany")}
              </p>
            ) : (
              <>
                <label className="bv-micro block mb-1.5">{t("app.pipelines.nlCompanyLabel")}</label>
                <select
                  value={createCompanyId}
                  onChange={(e) => setCreateCompanyId(e.target.value)}
                  className="w-full mb-4 px-3 py-2.5 rounded-xl text-sm outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    color: "var(--color-on-surface)",
                    fontFamily: "var(--bv-font-body)",
                  }}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>

                <label className="bv-micro block mb-1.5">{t("app.pipelines.nlDescLabel")}</label>
                <textarea
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  placeholder={t("app.pipelines.nlDescPlaceholder")}
                  rows={4}
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    color: "var(--color-on-surface)",
                    fontFamily: "var(--bv-font-body)",
                    resize: "vertical",
                  }}
                />
              </>
            )}

            {createErr && (
              <p className="bv-caption mt-2" style={{ color: "var(--bv-status-failed)" }}>
                {createErr}
              </p>
            )}

            <div className="bv-divider mt-4 mb-4" />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="bv-btn bv-btn-ghost bv-btn-sm"
              >
                {t("app.pipelines.nlCancel")}
              </button>
              <button
                onClick={handleCreatePipeline}
                disabled={creating || companies.length === 0 || createDesc.trim().length < 10}
                className="bv-btn bv-btn-primary bv-btn-sm bv-sheen"
              >
                {creating ? t("app.pipelines.nlCreating") : t("app.pipelines.nlCreate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
