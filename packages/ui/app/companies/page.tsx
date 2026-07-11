"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import styles from "./companies.module.css";

// Status → FORGE dot class + i18n label key (app.companies.*)
const STATUS_DOT: Record<string, { cls: string; labelKey: string }> = {
  ACTIVE:   { cls: "bv-running bv-ping",  labelKey: "statusRunning"  },
  PAUSED:   { cls: "bv-paused",           labelKey: "statusPaused"   },
  DRAFT:    { cls: "bv-cancelled",        labelKey: "statusDraft"    },
  ARCHIVED: { cls: "bv-failed",           labelKey: "statusArchived" },
};

// Primitive → bv-pill colour variant
const PRIMITIVE_PILL: Record<string, string> = {
  CONTENT:    "bv-pill-purple",
  ACQUISITION:"bv-pill-cyan",
  SALES:      "bv-pill-cyan",
  DELIVERY:   "bv-pill-cyan",
  ANALYTICS:  "bv-pill-purple",
  OPERATIONS: "bv-pill-muted",
  FINANCE:    "bv-pill-cyan",
  MEMORY:     "bv-pill-purple",
  GOVERNANCE: "bv-pill-red",
};

// Tiny inline sparkline (runs trend visualisation)
function Spark({ values }: { values?: number[] }) {
  const data = values && values.length > 1 ? values : [0, 0];
  const w = 260, h = 36;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${((i / (data.length - 1)) * w).toFixed(1)},${(
          h - ((v - min) / rng) * (h - 6) - 3
        ).toFixed(1)}`
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="bv-spark"
      aria-hidden="true"
    >
      <path
        d={pts}
        fill="none"
        stroke="var(--bv-cobalt-glow)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

type FilterKey = "all" | "ACTIVE" | "PAUSED" | "DRAFT";

export default function CompaniesPage() {
  const t = useTranslations();
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const [companies, setCompanies] = useState<any[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => {});
  }, [token]);

  const togglePause = async (id: string, isActive: boolean) => {
    if (!token || busyId) return;
    setBusyId(id);
    setActionError(false);
    try {
      if (isActive) await api.pauseCompany(token, id);
      else await api.resumeCompany(token, id);
      const fresh = await api.listCompanies(token);
      setCompanies(fresh);
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  };

  if (!hydrated || !token)
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{
            borderColor: "rgba(59,130,246,0.3)",
            borderTopColor: "var(--bv-cobalt-glow)",
          }}
        />
      </div>
    );

  // Derived filter counts
  const counts = {
    all: companies.length,
    ACTIVE: companies.filter((c) => c.status === "ACTIVE").length,
    PAUSED: companies.filter((c) => c.status === "PAUSED").length,
    DRAFT:  companies.filter((c) => c.status === "DRAFT").length,
  };

  const visible = companies.filter((c) => {
    const matchFilter = filter === "all" || c.status === filter;
    const matchQuery  = !query || c.name?.toLowerCase().includes(query.toLowerCase());
    return matchFilter && matchQuery;
  });

  const FILTERS: { key: FilterKey; label: string; dot?: string }[] = [
    { key: "all",    label: t("app.companies.filterAll") },
    { key: "ACTIVE", label: t("app.companies.statusRunning"),  dot: "bv-running" },
    { key: "PAUSED", label: t("app.companies.statusPaused"),   dot: "bv-paused"  },
    { key: "DRAFT",  label: t("app.companies.statusDraft"),    dot: "bv-cancelled"},
  ];

  return (
    <div className={`max-w-7xl mx-auto px-6 py-8 bv-dash animate-fade-in ${styles.companiesShell}`}>

      {/* ── Page head ─────────────────────────────────────── */}
      <div className="bv-page-head mb-8">
        <div>
          {/* eyebrow — mono "> " kicker (dashboard.module.css .kicker, ported),
              same t() string as before, no i18n change */}
          <p className={styles.kicker}>
            {t("app.companies.warRoom")}
          </p>
          <h1 className="bv-headline" style={{ color: "var(--color-on-surface)" }}>
            {t("app.companies.title")}
          </h1>
          <p className="bv-caption mt-1">
            {t("app.companies.countPlural", { count: companies.length })}
          </p>
        </div>

        <div className="bv-page-head-actions">
          <Link href="/companies/new" className="bv-btn bv-btn-primary bv-sheen">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              add
            </span>
            {t("app.companies.newCompany")}
          </Link>
        </div>
      </div>

      {/* ── Search + filter bar ───────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        {/* Search field */}
        <div className="relative" style={{ flex: "1 1 0", maxWidth: 360 }}>
          <span
            className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2"
            style={{ fontSize: 16, color: "var(--color-outline)", pointerEvents: "none" }}
          >
            search
          </span>
          <input
            type="search"
            placeholder={t("app.companies.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none"
            style={{
              background: "var(--color-surface-container-low)",
              border: "1px solid var(--color-outline-variant)",
              color: "var(--color-on-surface)",
              transition: "border-color 0.2s",
            }}
            onFocus={(e) =>
              (e.currentTarget.style.borderColor = "rgba(59,130,246,0.45)")
            }
            onBlur={(e) =>
              (e.currentTarget.style.borderColor =
                "var(--color-outline-variant)")
            }
          />
        </div>

        {/* Filter chips */}
        <div className="bv-fpills">
          {FILTERS.map(({ key, label, dot }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`bv-fpill${filter === key ? " active" : ""}`}
            >
              {dot && (
                <span className={`bv-dot ${dot}`} style={{ width: 7, height: 7 }} />
              )}
              {label}
              <span className="bv-fpill-count">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div
          className="bv-glass rounded-xl px-4 py-3 mb-4"
          style={{ border: "1px solid rgba(255,77,77,0.4)", color: "#FF4D4D", fontSize: 13 }}
          role="alert"
        >
          {t("app.companies.actionFailed")}
        </div>
      )}

      {/* ── Workspace grid ────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className="bv-glass bv-rim rounded-2xl text-center py-20 bv-rise">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{
              background: "rgba(59,130,246,0.08)",
              border: "1px solid rgba(59,130,246,0.18)",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 32, color: "var(--color-primary)" }}
            >
              business
            </span>
          </div>
          <div
            className="bv-pill bv-pill-amber mx-auto mb-4"
            style={{ width: "fit-content" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
              star
            </span>
            {t("app.companies.flagshipPill")}
          </div>
          <p
            className="bv-title mb-2"
            style={{ color: "var(--color-on-surface)" }}
          >
            {query || filter !== "all"
              ? t("app.companies.noMatchTitle")
              : t("app.companies.emptyTitle")}
          </p>
          <p
            className="bv-caption mx-auto mb-6"
            style={{ maxWidth: "38ch" }}
          >
            {query || filter !== "all"
              ? t("app.companies.noMatchBody")
              : t("app.companies.emptyBody")}
          </p>
          <Link href="/companies/new" className="bv-btn bv-btn-primary bv-sheen">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              add
            </span>
            {t("app.companies.createFirst")}
          </Link>
        </div>
      ) : (
        <div
          className="bv-stagger"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 18,
          }}
        >
          {visible.map((c) => {
            const st = STATUS_DOT[c.status] ?? STATUS_DOT.DRAFT;
            const agentCount  = c._count?.agents   ?? c.agents?.length   ?? 0;
            const runCount    = c._count?.pipelines ?? c.pipelines?.length ?? 0;
            const isActive    = c.status === "ACTIVE";
            const canToggle   = c.status === "ACTIVE" || c.status === "PAUSED";
            const isBusy      = busyId === c.id;

            return (
              <Link
                key={c.id}
                href={`/companies/${c.id}`}
                className="bv-glass bv-rim"
                style={{ display: "flex", flexDirection: "column", padding: 22, textDecoration: "none" }}
              >
                {/* Card top */}
                <div
                  style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 6 }}
                >
                  {/* Avatar */}
                  <div className="bv-avatar" style={{ width: 40, height: 40, borderRadius: 12, fontSize: 14, flexShrink: 0 }}>
                    {c.name?.charAt(0) ?? "?"}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      className="bv-title"
                      style={{
                        fontSize: 17,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.name}
                    </p>
                    <div
                      className="bv-mono"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 3,
                        color: "var(--color-on-surface-variant)",
                        fontSize: 11,
                      }}
                    >
                      <span className={`bv-dot ${st.cls}`} />
                      {t(`app.companies.${st.labelKey}`)}
                      {c.lastRunAt && (
                        <>
                          <span className="bv-divider-dot" />
                          <span style={{ color: "var(--color-outline)" }}>
                            {new Date(c.lastRunAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* "AI Company" flagship flag */}
                  {c.type === "AI_COMPANY" && (
                    <span className="bv-pill bv-pill-amber" style={{ marginLeft: "auto", flexShrink: 0 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 10 }}>star</span>
                      Flagship
                    </span>
                  )}
                </div>

                {/* Description */}
                {c.description ? (
                  <p
                    className="bv-caption line-clamp-2"
                    style={{ marginTop: 8, marginBottom: 10 }}
                  >
                    {c.description}
                  </p>
                ) : (
                  <p
                    className="bv-caption line-clamp-2"
                    style={{ marginTop: 8, marginBottom: 10, color: "var(--color-outline)" }}
                  >
                    {t("app.companies.noDescription")}
                  </p>
                )}

                {/* Meta row: agent count + run count */}
                <div
                  className="bv-mono"
                  style={{
                    display: "flex",
                    gap: 18,
                    fontSize: 12,
                    color: "var(--color-on-surface-variant)",
                    marginBottom: 8,
                  }}
                >
                  <span>
                    <strong style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                      {agentCount}
                    </strong>{" "}
                    {t("app.companies.agentsLabel")}
                  </span>
                  <span>
                    <strong style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                      {runCount}
                    </strong>{" "}
                    {t("app.companies.pipelinesLabel")}
                  </span>
                  <span style={{ marginLeft: "auto", color: "var(--color-outline)" }}>
                    {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {/* Sparkline */}
                <div style={{ height: 36, margin: "6px 0 14px" }}>
                  <Spark values={c.sparkValues} />
                </div>

                {/* Primitives */}
                {c.primitives && c.primitives.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                    {c.primitives.map((p: string) => (
                      <span
                        key={p}
                        className={`bv-pill ${PRIMITIVE_PILL[p] ?? "bv-pill-muted"}`}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                {/* Divider */}
                <div className="bv-divider" style={{ marginBottom: 14 }} />

                {/* Quick actions */}
                <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                  <button
                    className="bv-btn bv-btn-ghost bv-btn-sm"
                    style={{ flex: 1 }}
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(`/companies/${c.id}`);
                    }}
                  >
                    {t("app.companies.open")}
                  </button>
                  {canToggle && (
                    <button
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ flex: 1, opacity: isBusy ? 0.6 : 1 }}
                      disabled={isBusy}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        togglePause(c.id, isActive);
                      }}
                    >
                      {isActive
                        ? t("app.companies.pause")
                        : t("app.companies.resume")}
                    </button>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
