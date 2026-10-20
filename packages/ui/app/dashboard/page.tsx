"use client";
import { useStateLabel } from "../../lib/useStateLabel";

import { useDisplayFormats } from "../../lib/useDisplayFormats";

import { useLocale as useRelativeLocale } from "next-intl";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * /dashboard — command center.
 *
 * Visual refresh ported from the Claude Design handoff bundle in
 * /tmp/braavolabs-design (canonical source: Apps/Braavo/design/...).
 * Layout uses the new bv-* utility layer in globals.css; legacy
 * .glass-card / .metric-card paths still work elsewhere on the site.
 *
 * API contract is unchanged — same useAuthGuard, same parallel fetch
 * for health / usage / finance / listCompanies, plus listRuns +
 * listApprovals + riskEvents to power the recent-runs feed, the
 * approvals panel, and the risk panel.
 *
 * i18n: existing keys (app.dashboard.*) are reused. Strings new to the
 * refresh (greeting, panel titles like "Recent runs", "Risk events")
 * are intentionally inline English here — adding 8 new keys × 6
 * locales would inflate this PR. Follow-up: port the inline strings
 * to messages/{en,tr,es,de,fr,ar}.json once design lands.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency, formatNumber } from "../../i18n/locales";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore } from "../../lib/store";
import { sounds } from "../../lib/sounds";
import { timeAgo } from "../../lib/timeAgo";
import TrialBanner from "../../components/TrialBanner";
import SpendForecastCard from "../../components/SpendForecastCard";

interface HealthData { activeCompanies: number; activeRuns: number; pendingApprovals: number; }
interface UsageData { totalRuns: number; completedRuns: number; failedRuns: number; successRate: number; }
interface FinanceData { totalCostUsd: number; runCount: number; avgCostPerRun: number; }

type RunStatus = "RUNNING" | "COMPLETED" | "PAUSED" | "FAILED" | "CANCELLED" | "PENDING" | "WAITING_APPROVAL";

interface RunRow {
  id: string;
  pipelineName?: string;
  pipeline?: { name?: string; companyName?: string };
  companyName?: string;
  status: RunStatus;
  startedAt?: string;
  createdAt?: string;
  stepsCompleted?: number;
  stepsTotal?: number;
  costUsd?: number;
}

interface ApprovalRow {
  id: string;
  type?: string;
  description?: string;
  amountUsd?: number;
  createdAt?: string;
  metadata?: { toolName?: string };
}

interface RiskEvent {
  id: string;
  severity?: "high" | "medium" | "low" | "HIGH" | "MEDIUM" | "LOW";
  type?: string;
  message?: string;
  reason?: string;
  createdAt?: string;
  // Backend may flag freshly-arrived events; falls back to "<60s old"
  // so the flash animation only fires on actually-new entries.
  fresh?: boolean;
}

export default function DashboardPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const locale = useLocale();
  const { token, hydrated } = useAuthGuard();

  const revision = useAppStore(state => state.sessionRevision);
  const tenantId = useAppStore(state => state.tenantId);
  const scope = useMemo(() => ({ revision, tenantId }), [revision, tenantId]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; results: PromiseSettledResult<any>[] } | null>(null);
  const [runsFilter, setRunsFilter] = useState<"all" | "running" | "completed" | "pending" | "failed">("all");
  const results = snapshot?.scope === scope ? snapshot.results : null;
  const value = (index: number) => { const result = results?.[index]; return result?.status === "fulfilled" ? result.value : null; };
  const health = value(0) as HealthData | null;
  const usage = value(1) as UsageData | null;
  const finance = value(2) as FinanceData | null;
  const runsAvailable = Array.isArray(value(3)?.runs);
  const approvalsAvailable = Array.isArray(value(4));
  const risksAvailable = Array.isArray(value(5));
  const runs: RunRow[] = runsAvailable ? value(3).runs : [];
  const approvals: ApprovalRow[] = approvalsAvailable ? value(4) : [];
  const risks: RiskEvent[] = risksAvailable ? value(5) : [];
  const me = value(6) as { name?: string | null; email?: string } | null;
  const loaded = results !== null;
  const copy = useTranslations("surface");

  useEffect(() => {
    let active = true;
    if (!token) return;
    Promise.allSettled([
      api.health(token), api.usage(token), api.finance(token), api.listRuns(token, 12, 0),
      api.listApprovals(token, "PENDING"), api.riskEvents(token, 8), api.users.me(token),
    ]).then(results => {
      const auth = useAppStore.getState();
      if (active && latestScope.current === scope && auth.sessionRevision === revision && auth.tenantId === tenantId) setSnapshot({ scope, results });
    });
    return () => { active = false; };
  }, [token, scope, revision, tenantId]);

  const filteredRuns = useMemo(() => {
    if (runsFilter === "all") return runs;
    return runs.filter((r) => (r.status ?? "").toLowerCase() === runsFilter);
  }, [runs, runsFilter]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }}
        />
      </div>
    );
  }

  const greetingName = me?.name?.split(" ")[0] ?? me?.email?.split("@")[0] ?? copy("dashboard.operator");
  const greeting = copy(`dashboard.${greetingFor(new Date())}`);
  const spendLabel = finance
    ? t("app.dashboard.spentThisCycle", { amount: formatCurrency(finance.totalCostUsd, "USD", locale, { maximumFractionDigits: 0 }) })
    : "";

  return (
    <div className="bv-dash bv-dash-shell">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 24px 40px" }}>
        <TrialBanner token={token} />

        {/* ─── Page head: greeting + status sub-line + date-range ─── */}
        <div className="bv-page-head bv-rise" style={{ marginBottom: 26 }}>
          <div>
            {/* eyebrow */}
            <div className="bv-micro" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>speed</span>
              {t("app.dashboard.title")}
            </div>
            {/* display greeting */}
            <h1
              className="bv-display"
              style={{ margin: 0, fontSize: "clamp(26px, 3vw, 36px)", textTransform: "uppercase", letterSpacing: "-0.01em" }}
            >
              {greeting},{" "}
              <span className="bv-grad-text">{greetingName}</span>
            </h1>
            {/* status sub-line */}
            <div
              className="bv-caption"
              style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`bv-dot ${health?.activeRuns ? "bv-running bv-ping" : "bv-paused"}`} aria-hidden />
                {(health?.activeRuns ?? 0) > 0
                  ? t("app.dashboard.statusStreaming", { count: health!.activeRuns })
                  : health?.activeRuns === 0 ? t("app.dashboard.statusQuiet") : t("app.analytics.unavailable")}
              </span>
              {(health?.pendingApprovals ?? 0) > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>
                    {t("app.dashboard.approvalsAwaiting", { count: health!.pendingApprovals })}
                  </span>
                </>
              )}
              {risks.length > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>{t("app.dashboard.risksNeedEye", { count: risks.length })}</span>
                </>
              )}
              {spendLabel && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>{spendLabel}</span>
                </>
              )}
            </div>
          </div>

          <div className="bv-page-head-actions">
            <Link
              href="/companies/new"
              className="bv-btn bv-btn-primary bv-btn-sm"
              onClick={() => sounds.build()}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              <span>{t("app.dashboard.newCompany")}</span>
            </Link>
          </div>
        </div>

        {/* ─── KPI cards (4 cols) with sparklines ──────────────────── */}
        <div className="bv-metrics bv-stagger" style={{ marginBottom: 26 }}>
          <KpiCard
            label={uiText("me587bca8ef51")}
            value={formatNumber(health?.activeRuns, locale)}
            dot="running"
            loaded={loaded}

          />
          <KpiCard
            label={t("app.dashboard.metricTotalCost")}
            value={finance ? formatCurrency(finance.totalCostUsd, "USD", locale, { maximumFractionDigits: 0 }) : "—"}

            dot="failed"
            warn={!!(finance && finance.totalCostUsd > 0)}
            loaded={loaded}

          />
          <KpiCard
            label={t("app.dashboard.metricPendingApprovals")}
            value={formatNumber(health?.pendingApprovals, locale)}
            dot="completed"
            loaded={loaded}

          />
          <KpiCard
            label={uiText("m975cf8ab658e")}
            value={usage ? formatNumber(usage.successRate, locale, { style: "percent", maximumFractionDigits: 1 }) : "—"}
            dot="completed"
            loaded={loaded}

          />
        </div>

        {/* ─── 2-column: main (runs + activity) / side rail ──────── */}
        <div className="bv-twocol">
          {/* MAIN column */}
          <div className="bv-twocol-main">
            {loaded && !runsAvailable ? <UnavailablePanel title={t("app.dashboard.recentRuns")} /> : <RecentRunsPanel
              runs={filteredRuns}
              total={runs.length}
              loaded={loaded}
              filter={runsFilter}
              setFilter={setRunsFilter}
              counts={{
                all: runs.length,
                running: runs.filter((r) => (r.status ?? "").toLowerCase() === "running").length,
                completed: runs.filter((r) => (r.status ?? "").toLowerCase() === "completed").length,
                pending: runs.filter((r) => (r.status ?? "").toLowerCase() === "pending").length,
                failed: runs.filter((r) => (r.status ?? "").toLowerCase() === "failed").length,
              }}
            />}

            {/* Activity feed */}
            <section className="bv-glass bv-panel">
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>history</span>{uiText("m1ca31645c880")}</h2>
                  <div className="bv-caption">{copy("dashboard.snapshot")}</div>
                </div>
              </header>
              {loaded && (!runsAvailable || !approvalsAvailable || !risksAvailable) ? <p role="status">{copy("loadFailed")}</p> : <ActivityFeed runs={runs} approvals={approvals} risks={risks} loaded={loaded} />}
            </section>
          </div>

          {/* SIDE RAIL */}
          <div className="bv-twocol-side">
            <SpendForecastCard />
            {loaded && !approvalsAvailable ? <UnavailablePanel title={t("app.dashboard.pendingApprovalsBanner")} /> : <ApprovalsPanel approvals={approvals} loaded={loaded} t={t} />}
            {loaded && !risksAvailable ? <UnavailablePanel title={t("app.dashboard.riskEvents")} /> : <RiskPanel risks={risks} loaded={loaded} />}
            <section className="bv-glass bv-panel"><h2 className="bv-title">{t("nav.drafts")}</h2><Link href="/drafts" className="bv-btn bv-btn-ghost">{t("app.dashboard.viewAll")}</Link></section>
          </div>
        </div>

        {/* ─── Page foot ─────────────────────────────────────────── */}
        <footer
          className="bv-mono"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 0 0",
            marginTop: 22,
            fontSize: 11,
            color: "var(--color-outline)",
            borderTop: "1px solid var(--bv-glass-border)",
          }}
        >
          <span>{uiText("m9f12c64beaa6")}</span>
        </footer>
      </div>
    </div>
  );
}

/* ─────────────────────────────  helpers  ───────────────────────────── */

function greetingFor(now: Date): "morning" | "afternoon" | "evening" {
  // i18n: hardcoded — follow-up app.dashboard.greeting{Morning,Afternoon,Evening}
  const h = now.getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function pipelineNameOf(r: RunRow): string {
  return r.pipelineName ?? r.pipeline?.name ?? r.id;
}
function companyNameOf(r: RunRow): string {
  return r.companyName ?? r.pipeline?.companyName ?? "—";
}
function runStartedRel(r: RunRow, locale: string): string {
  const at = r.startedAt ?? r.createdAt;
  return at ? timeAgo(at, locale) : "—";
}
function runStepsLabel(r: RunRow): string {
  if (typeof r.stepsCompleted === "number" && typeof r.stepsTotal === "number") {
    return `${r.stepsCompleted} / ${r.stepsTotal}`;
  }
  return "—";
}
function runSpendLabel(r: RunRow): string {
  return typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(2)}` : "—";
}

/* ─────────────────────────  KpiCard  ───────────────────────── */

function KpiCard(props: {
  label: string;
  value: string | number;
  valueSuffix?: string;
  dot: "running" | "completed" | "paused" | "failed";
  warn?: boolean;
  loaded?: boolean;
}) {
  const { label, value, valueSuffix, dot, warn, loaded } = props;
  return (
    <div className="bv-glass" style={{ padding: "20px 22px", position: "relative" }}>
      {/* label row */}
      <div
        className="bv-mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--color-outline)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className={`bv-dot bv-${dot}${dot === "running" ? " bv-ping" : ""}`} aria-hidden />
        {label}
      </div>
      {/* value */}
      <div
        className="bv-numeric"
        style={{
          fontSize: 38,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          marginTop: 10,
          lineHeight: 1,
          color: warn ? "var(--bv-status-running)" : "var(--color-on-surface)",
        }}
      >
        {loaded === false ? (
          <span style={{ opacity: 0.3 }}>—</span>
        ) : (
          <>
            {value}
            {valueSuffix && (
              <span
                style={{
                  fontSize: 15,
                  color: "var(--color-on-surface-variant)",
                  fontFamily: "var(--bv-font-body)",
                  fontWeight: 400,
                }}
              >
                {valueSuffix}
              </span>
            )}
          </>
        )}
      </div>

    </div>
  );
}

/* ─────────────────────────  RecentRunsPanel  ───────────────────────── */

function RecentRunsPanel(props: {
  runs: RunRow[];
  total: number;
  loaded: boolean;
  filter: "all" | "running" | "completed" | "pending" | "failed";
  setFilter: (f: "all" | "running" | "completed" | "pending" | "failed") => void;
  counts: Record<"all" | "running" | "completed" | "pending" | "failed", number>;
}) {
  const displayFormat = useDisplayFormats();
  const relativeLocale = useRelativeLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const { runs, loaded, filter, setFilter, counts } = props;
  const t = useTranslations();

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`bv-dot bv-running bv-ping`} aria-hidden />
            {t("app.dashboard.recentRuns")}
          </h2>
          <div className="bv-caption">{t("surface.dashboard.snapshot")}</div>
        </div>
        <div className="bv-panel-head-actions">
          <Link href="/runs" className="bv-btn bv-btn-ghost bv-btn-sm">
            <span>{uiText("maacbbd2ffeb8")}</span>
          </Link>
        </div>
      </header>

      <div className="bv-fpills">
        {([
          ["all", "All"],
          ["running", "Running"],
          ["completed", "Completed"],
          ["pending", "Pending"],
          ["failed", "Failed"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`bv-fpill ${filter === id ? "active" : ""}`}
            onClick={() => setFilter(id)}
          >
            <span>{label}</span>
            <span className="bv-fpill-count">{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="bv-runs-table" role="table" aria-label={uiText("mef4047de09c7")}>
        {/* header row */}
        <div className="bv-runs-row bv-runs-head" role="row">
          <span>{uiText("m9332d1be8fe2")}</span>
          <span>{uiText("m098593629f8e")}</span>
          <span>{uiText("m286c98c9029c")}</span>
          <span>{uiText("m207013f4c387")}</span>
          <span>{uiText("md1d31b068fc2")}</span>
          <span style={{ textAlign: "end" }}>{uiText("m701b95d1d46a")}</span>
        </div>

        {!loaded ? (
          <div style={{ padding: "16px 4px" }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-shimmer" style={{ height: 36, marginBottom: 6, borderRadius: 8 }} />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div style={{ padding: "32px 8px", textAlign: "center", color: "var(--color-outline)" }}>{uiText("m4d36fe121a92")}</div>
        ) : (
          <div className="bv-stagger">
            {runs.slice(0, 8).map((r) => {
              const st = (r.status ?? "").toLowerCase();
              return (
                <Link
                  key={r.id}
                  href={`/runs/${r.id}`}
                  role="row"
                  className="bv-runs-row"
                  style={{ textDecoration: "none" }}
                >
                  {/* pipeline */}
                  <span className="bv-runs-pipeline">
                    <span className="material-symbols-outlined" aria-hidden>account_tree</span>
                    <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span
                        style={{
                          fontWeight: 600,
                          color: "var(--color-on-surface)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {pipelineNameOf(r)}
                      </span>
                      <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>
                        {r.id.slice(0, 12)}
                      </span>
                    </span>
                  </span>
                  {/* company */}
                  <span className="bv-runs-company">{companyNameOf(r)}</span>
                  {/* status */}
                  <span>
                    <StatusLabel status={st as Lowercase<RunStatus>} />
                  </span>
                  {/* started */}
                  <span className="bv-runs-started">{runStartedRel(r, relativeLocale)}</span>
                  {/* steps with dot-track */}
                  <span>
                    <RunProgress completed={r.stepsCompleted} total={r.stepsTotal} />
                  </span>
                  {/* spend */}
                  <span style={{ textAlign: "end" }} className="bv-mono">
                    {displayFormat.usd(r.costUsd)}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** Unknown counts remain unknown; the native progress element has bounded DOM. */
function RunProgress({ completed, total }: { completed?: number; total?: number }) {
  const locale = useLocale();
  const copy = useTranslations("surface");
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed! < 0 || total! < 0 || completed! > total!) {
    return <span className="bv-caption">{copy("unavailable")}</span>;
  }
  const label = copy("progress", { completed: formatNumber(completed, locale), total: formatNumber(total, locale) });
  return total === 0 ? <span className="bv-caption">{label}</span> : <progress aria-label={label} max={total} value={completed} style={{ width: 88, maxWidth: "100%", accentColor: "var(--color-primary)" }} />;
}

function StatusLabel({ status }: { status: string }) {
  const copy = useTranslations("surface");
  const known = ["running", "completed", "paused", "failed", "cancelled", "waiting_approval", "pending"].includes(status);
  const label = copy(known ? `states.${status}` : "unavailable");
  const cls = !known ? "bv-cancelled" : status === "waiting_approval" || status === "pending" ? "bv-pending" : `bv-${status}`;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span className={`bv-dot ${cls} ${status === "running" ? "bv-ping" : ""}`} aria-hidden /><span className="bv-caption">{label}</span></span>;
}

/* ─────────────────────────  ActivityFeed  ───────────────────────── */

function ActivityFeed({
  runs,
  approvals,
  risks,
  loaded,
}: {
  runs: RunRow[];
  approvals: ApprovalRow[];
  risks: RiskEvent[];
  loaded: boolean;
}) {
  const stateLabel = useStateLabel();
  const relativeLocale = useRelativeLocale();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  type ActivityItem = { text: string; time: string; icon: string; iconColor?: string };

  const items: ActivityItem[] = useMemo(() => {
    const all: ActivityItem[] = [];

    runs.slice(0, 3).forEach((r) => {
      const nm = pipelineNameOf(r);
      const st = (r.status ?? "").toLowerCase();
      all.push({
        text: st === "running" ? runtimeCopy("mfe990aab3694", { value0: nm }) : `${nm} · ${stateLabel(st)}`,
        time: runStartedRel(r, relativeLocale),
        icon: st === "running" ? "bolt" : st === "completed" ? "check_circle" : st === "failed" ? "error" : "schedule",
        iconColor: st === "running" ? "var(--bv-status-running)" : st === "completed" ? "var(--bv-cobalt-glow)" : st === "failed" ? "var(--bv-status-failed)" : undefined,
      });
    });

    approvals.slice(0, 2).forEach((a) => {
      all.push({
        text: runtimeCopy("m7a54036ca778", { value0: a.description ?? stateLabel("pending") }),
        time: timeAgo(a.createdAt, relativeLocale),
        icon: "paid",
        iconColor: "var(--bv-status-running)",
      });
    });

    risks.slice(0, 2).forEach((r) => {
      all.push({
        text: r.message ?? r.type ?? runtimeCopy("me54aaeee8d00"),
        time: timeAgo(r.createdAt, relativeLocale),
        icon: "gpp_maybe",
        iconColor: "var(--bv-status-failed)",
      });
    });

    return all.slice(0, 7);
  }, [runs, approvals, risks, relativeLocale]);

  if (!loaded) {
    return (
      <div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-shimmer" style={{ height: 32, marginBottom: 10, borderRadius: 8 }} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--color-outline)", fontSize: 12 }}>{uiText("m97fa546fb5a7")}</div>
    );
  }

  return (
    <div>
      {items.map((item, idx) => (
        <div
          key={idx}
          style={{ display: "grid", gridTemplateColumns: "30px 1fr", gap: 14, position: "relative", paddingBottom: 16 }}
        >
          {/* left rail: node + line */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: "50%",
                background: "var(--color-surface-container)",
                border: "2px solid var(--bv-cobalt-glow)",
                boxShadow: "0 0 8px var(--bv-cobalt-glow)",
                marginTop: 3,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            />
            {idx < items.length - 1 && (
              <div
                style={{
                  flex: 1,
                  width: 2,
                  marginTop: 3,
                  background: "linear-gradient(180deg, var(--bv-cobalt-glow), rgba(59,130,246,0.08))",
                  minHeight: 16,
                }}
              />
            )}
          </div>
          {/* right: text + meta */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--color-on-surface)" }}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 14, color: item.iconColor ?? "var(--color-outline)" }}
                aria-hidden
              >
                {item.icon}
              </span>
              {item.text}
            </div>
            <div className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 2 }}>
              {item.time}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────  ApprovalsPanel  ───────────────────────── */

function ApprovalsPanel({
  approvals,
  loaded,
  t,
}: {
  approvals: ApprovalRow[];
  loaded: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const displayFormat = useDisplayFormats();
  const relativeLocale = useRelativeLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const list = approvals.slice(0, 4);

  return (
    <section className={`bv-glass bv-panel ${approvals.length > 0 ? "bv-pulse-glow" : ""}`}>
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>approval</span>
            {t("app.dashboard.pendingApprovalsBanner")}
          </h2>
          <div className="bv-caption">{t("surface.dashboard.snapshot")}</div>
        </div>
        {approvals.length > 0 && (
          <span className="bv-pill bv-pill-amber">
            {approvals.length}{" "}{uiText("mc9b9115552be")}</span>
        )}
      </header>

      {!loaded ? (
        <ul className="bv-approval-list">
          {[1, 2].map((i) => (
            <li key={i} className="bv-approval-item">
              <div className="animate-shimmer" style={{ width: 28, height: 28, borderRadius: 8 }} />
              <div style={{ flex: 1 }}>
                <div className="animate-shimmer" style={{ height: 12, width: "70%", borderRadius: 4 }} />
                <div className="animate-shimmer" style={{ height: 10, width: "40%", marginTop: 6, borderRadius: 4 }} />
              </div>
            </li>
          ))}
        </ul>
      ) : list.length === 0 ? (
        <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--color-outline)", fontSize: 12 }}>
          {t("app.dashboard.inboxZero")}
        </div>
      ) : (
        <ul className="bv-approval-list">
          {list.map((a) => (
            <li key={a.id} className="bv-approval-item">
              <span className="bv-approval-icon" aria-hidden>
                <span className="material-symbols-outlined">
                  {a.type === "SPEND" ? "paid" : a.metadata?.toolName ? "send" : "description"}
                </span>
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="bv-approval-title">
                  {a.description ?? a.metadata?.toolName ??uiText("m7fd8a8fd26df")}
                </div>
                <div className="bv-approval-meta">
                  {typeof a.amountUsd === "number" ? (
                    <span style={{ color: "var(--bv-status-running)", fontFamily: "var(--bv-font-mono)", fontSize: 15, fontWeight: 500 }}>
                      {displayFormat.usd(a.amountUsd)}
                    </span>
                  ) : (
                    a.type ?? "—"
                  )}
                  {a.createdAt && <> · {timeAgo(a.createdAt, relativeLocale)}</>}
                </div>
              </div>
              <div className="bv-approval-actions">
                <Link href={`/approvals?id=${a.id}`} className="bv-btn bv-btn-primary bv-btn-sm">
                  {t("app.dashboard.review")}
                </Link>
                <Link href={`/approvals?id=${a.id}&deny=1`} className="bv-btn bv-btn-ghost bv-btn-sm">{uiText("meffd0c9f293a")}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {approvals.length > list.length && (
        <Link href="/approvals" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ marginTop: 4 }}>
          <span>{t("app.dashboard.viewAll")}</span>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
        </Link>
      )}
    </section>
  );
}

/* ─────────────────────────  RiskPanel  ───────────────────────── */

function RiskPanel({ risks, loaded }: { risks: RiskEvent[]; loaded: boolean }) {
  const relativeLocale = useRelativeLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const list = risks.slice(0, 5);
  const t = useTranslations();

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>gpp_maybe</span>
            {t("app.dashboard.riskEvents")}
          </h2>
          <div className="bv-caption">
            {!loaded ? t("surface.loading") : risks.length === 0 ? uiText("m8961771af3a1") : t("surface.dashboard.activeRisks", { count: risks.length })}
          </div>
        </div>
        {risks.some((r) => r.fresh) && (
          <span className="bv-pill bv-pill-red">{risks.filter((r) => r.fresh).length}{" "}{uiText("m11064e50fa7c")}</span>
        )}
      </header>

      {!loaded ? (
        <ul className="bv-risk-list">
          {[1, 2, 3].map((i) => (
            <li key={i} className="bv-risk-item">
              <span className="bv-risk-sev bv-risk-sev-low" />
              <div style={{ flex: 1 }}>
                <div className="animate-shimmer" style={{ height: 12, width: "60%", borderRadius: 4 }} />
                <div className="animate-shimmer" style={{ height: 10, width: "40%", marginTop: 6, borderRadius: 4 }} />
              </div>
            </li>
          ))}
        </ul>
      ) : list.length === 0 ? (
        <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--color-outline)", fontSize: 12 }}>
          {t("app.dashboard.noRisksRaised")}
        </div>
      ) : (
        <ul className="bv-risk-list">
          {list.map((r) => {
            const rawSeverity = String(r.severity ?? "").toLowerCase();
            const sev = ["high", "medium", "low"].includes(rawSeverity) ? rawSeverity : "unknown";
            return (
              <li key={r.id} className={`bv-risk-item ${r.fresh ? "bv-risk-flash" : ""}`}>
                <div role="img" className={`bv-risk-sev ${sev === "unknown" ? "" : `bv-risk-sev-${sev}`}`} aria-label={t(`surface.severity.${sev}`)} />
                <div>
                  <div className="bv-risk-title">{r.message ?? r.type ??uiText("m3c3e08c03c30")}</div>
                  {r.reason && <div className="bv-risk-detail">{r.reason}</div>}
                </div>
                <div className="bv-risk-when">{r.createdAt ? timeAgo(r.createdAt, relativeLocale) :uiText("me5c88f2a2ff0")}</div>
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/risks" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ width: "100%", marginTop: 4 }}>
        <span>{t("app.dashboard.openRiskInbox")}</span>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
      </Link>
    </section>
  );
}

/* ─────────────────────────  DraftsPanel  ───────────────────────── */

// Derives a "recent drafts" list from completed run IDs — mirrors the
// mock's .rcard[recent drafts] rail card. No new API call is needed.
function UnavailablePanel({ title }: { title: string }) {
  const copy = useTranslations("surface");
  return <section className="bv-glass bv-panel"><h2 className="bv-title">{title}</h2><p role="status" className="bv-caption">{copy("loadFailed")}</p></section>;
}
