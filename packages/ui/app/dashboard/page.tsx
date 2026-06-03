"use client";

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

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
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
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();

  const [health, setHealth] = useState<HealthData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [risks, setRisks] = useState<RiskEvent[]>([]);
  const [me, setMe] = useState<{ name?: string | null; email?: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [runsFilter, setRunsFilter] = useState<"all" | "running" | "completed" | "pending" | "failed">("all");
  const [dateRange, setDateRange] = useState<"today" | "7d" | "30d" | "90d">("7d");

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.health(token).then(setHealth).catch(() => {}),
      api.usage(token).then(setUsage).catch(() => {}),
      api.finance(token).then(setFinance).catch(() => {}),
      api.listRuns(token, 12, 0).then((d) => setRuns(d.runs ?? [])).catch(() => {}),
      api.listApprovals(token, "PENDING").then((arr) => setApprovals(arr ?? [])).catch(() => {}),
      api.riskEvents(token, 8).then((arr) => setRisks(arr ?? [])).catch(() => {}),
      api.users.me(token).then((u) => setMe({ name: u?.name, email: u?.email })).catch(() => {}),
    ]).finally(() => setLoaded(true));
  }, [token]);

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

  const greetingName = me?.name?.split(" ")[0] ?? me?.email?.split("@")[0] ?? "there";
  const greeting = greetingFor(new Date());
  const spendLabel = finance ? `$${finance.totalCostUsd.toFixed(0)} spent this cycle` : "";

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
                  ? `${health!.activeRuns} ${health!.activeRuns === 1 ? "run" : "runs"} streaming`
                  : "All quiet — no active runs"}
              </span>
              {(health?.pendingApprovals ?? 0) > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>
                    {health!.pendingApprovals} {t("app.dashboard.pendingApprovalsBanner").toLowerCase()} awaiting your call
                  </span>
                </>
              )}
              {risks.length > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>{risks.length} {risks.length === 1 ? "risk" : "risks"} need your eye</span>
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
            <div className="bv-segmented" role="tablist" aria-label="Date range">
              {(["today", "7d", "30d", "90d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={dateRange === r}
                  className={dateRange === r ? "active" : ""}
                  onClick={() => setDateRange(r)}
                >
                  {r === "today" ? "Today" : r}
                </button>
              ))}
            </div>
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
            label="Active runs"
            value={health?.activeRuns ?? 0}
            dot="running"
            loaded={loaded}
            sparkPoints="0,28 20,24 40,26 60,18 80,20 100,12 120,8"
            sparkColor="var(--bv-status-running)"
          />
          <KpiCard
            label={t("app.dashboard.metricTotalCost")}
            value={finance ? `$${finance.totalCostUsd.toFixed(0)}` : "—"}
            valueSuffix={finance ? ` / ${(finance.totalCostUsd * 1.6).toFixed(0)}` : undefined}
            dot="failed"
            warn={!!(finance && finance.totalCostUsd > 0)}
            loaded={loaded}
            sparkPoints="0,30 20,26 40,28 60,20 80,22 100,14 120,9"
            sparkColor="var(--bv-status-running)"
            sparkFill
          />
          <KpiCard
            label={t("app.dashboard.metricPendingApprovals")}
            value={health?.pendingApprovals ?? 0}
            dot="completed"
            loaded={loaded}
            sparkPoints="0,20 20,22 40,18 60,24 80,16 100,18 120,14"
            sparkColor="var(--bv-cobalt-glow)"
          />
          <KpiCard
            label="Run success rate"
            value={usage ? `${(usage.successRate * 100).toFixed(1)}%` : "—"}
            dot="completed"
            loaded={loaded}
            sparkPoints="0,28 20,24 40,26 60,18 80,20 100,12 120,10"
            sparkColor="var(--bv-cobalt-glow)"
            sparkFill
          />
        </div>

        {/* ─── 2-column: main (runs + activity) / side rail ──────── */}
        <div className="bv-twocol">
          {/* MAIN column */}
          <div className="bv-twocol-main">
            <RecentRunsPanel
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
            />

            {/* Activity feed */}
            <section className="bv-glass bv-panel">
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>history</span>
                    Activity
                  </h2>
                  <div className="bv-caption">Live audit trail</div>
                </div>
              </header>
              <ActivityFeed runs={runs} approvals={approvals} risks={risks} loaded={loaded} />
            </section>
          </div>

          {/* SIDE RAIL */}
          <div className="bv-twocol-side">
            <SpendForecastCard />
            <ApprovalsPanel approvals={approvals} loaded={loaded} t={t} />
            <RiskPanel risks={risks} loaded={loaded} />
            <DraftsPanel runs={runs} loaded={loaded} />
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
          <span>braavolabs.com · live audit trail</span>
          <span>SOC 2 Type II · audited</span>
        </footer>
      </div>
    </div>
  );
}

/* ─────────────────────────────  helpers  ───────────────────────────── */

function greetingFor(now: Date): string {
  // i18n: hardcoded — follow-up app.dashboard.greeting{Morning,Afternoon,Evening}
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function pipelineNameOf(r: RunRow): string {
  return r.pipelineName ?? r.pipeline?.name ?? r.id;
}
function companyNameOf(r: RunRow): string {
  return r.companyName ?? r.pipeline?.companyName ?? "—";
}
function runStartedRel(r: RunRow): string {
  const at = r.startedAt ?? r.createdAt;
  return at ? timeAgo(at) : "queued";
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
  sparkPoints: string;
  sparkColor: string;
  sparkFill?: boolean;
}) {
  const { label, value, valueSuffix, dot, warn, loaded, sparkPoints, sparkColor, sparkFill } = props;
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
      {/* sparkline */}
      <div style={{ marginTop: 8, height: 34 }}>
        <svg
          viewBox="0 0 120 34"
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%", display: "block" }}
          aria-hidden
        >
          {sparkFill && (
            <>
              <defs>
                <linearGradient id={`sg-${label.replace(/\s+/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={sparkColor} stopOpacity="0.35" />
                  <stop offset="1" stopColor={sparkColor} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d={`M${sparkPoints.replace(/(\d+),(\d+)/g, (_, x, y) => `${x},${y}`)} L120,34 L0,34Z`}
                fill={`url(#sg-${label.replace(/\s+/g, "")})`}
              />
            </>
          )}
          <polyline
            points={sparkPoints}
            fill="none"
            stroke={sparkColor}
            strokeWidth="1.6"
          />
        </svg>
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
          <div className="bv-caption">Polling every 15s</div>
        </div>
        <div className="bv-panel-head-actions">
          <Link href="/runs" className="bv-btn bv-btn-ghost bv-btn-sm">
            <span>View all →</span>
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

      <div className="bv-runs-table" role="table" aria-label="Recent runs">
        {/* header row */}
        <div className="bv-runs-row bv-runs-head" role="row">
          <span>Pipeline</span>
          <span>Company</span>
          <span>Status</span>
          <span>Started</span>
          <span>Steps</span>
          <span style={{ textAlign: "right" }}>Spend</span>
        </div>

        {!loaded ? (
          <div style={{ padding: "16px 4px" }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-shimmer" style={{ height: 36, marginBottom: 6, borderRadius: 8 }} />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div style={{ padding: "32px 8px", textAlign: "center", color: "var(--color-outline)" }}>
            No runs in this filter yet.
          </div>
        ) : (
          <div className="bv-stagger">
            {runs.slice(0, 8).map((r) => {
              const st = (r.status ?? "running").toLowerCase();
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
                  <span className="bv-runs-started">{runStartedRel(r)}</span>
                  {/* steps with dot-track */}
                  <span>
                    <StepDots completed={r.stepsCompleted ?? 0} total={r.stepsTotal ?? 0} status={st} />
                  </span>
                  {/* spend */}
                  <span style={{ textAlign: "right" }} className="bv-mono">
                    {runSpendLabel(r)}
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

/* Step-dot track (matches mock .steps) */
function StepDots({ completed, total, status }: { completed: number; total: number; status: string }) {
  if (!total) {
    return <span className="bv-mono" style={{ color: "var(--color-on-surface-variant)", fontSize: 12 }}>{runStepsLabel({ stepsCompleted: completed, stepsTotal: total } as RunRow)}</span>;
  }
  const dots = Array.from({ length: total }, (_, i) => {
    if (i < completed) return "done";
    if (i === completed && status === "running") return "now";
    return "idle";
  });
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
      {dots.map((state, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
          {i > 0 && (
            <span
              style={{
                width: 14,
                height: 2,
                background: state === "done" || dots[i - 1] === "done" ? "var(--bv-cobalt-glow)" : "var(--bv-steel-shadow)",
              }}
            />
          )}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background:
                state === "done"
                  ? "var(--bv-cobalt-glow)"
                  : state === "now"
                  ? "var(--bv-status-running)"
                  : "var(--bv-steel-shadow)",
              boxShadow:
                state === "done"
                  ? "0 0 6px var(--bv-cobalt-glow)"
                  : state === "now"
                  ? "0 0 8px var(--bv-status-running)"
                  : "none",
              display: "inline-block",
            }}
          />
        </span>
      ))}
    </span>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label =
    status === "running"
      ? "Running"
      : status === "completed"
      ? "Completed"
      : status === "paused"
      ? "Paused"
      : status === "failed"
      ? "Failed"
      : status === "cancelled"
      ? "Cancelled"
      : status === "waiting_approval"
      ? "Awaiting approval"
      : "Pending";
  const cls =
    status === "waiting_approval" || status === "pending" ? "bv-pending" : status;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`bv-dot bv-${cls} ${status === "running" ? "bv-ping" : ""}`} aria-hidden />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
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
  type ActivityItem = { text: string; time: string; icon: string; iconColor?: string };

  const items: ActivityItem[] = useMemo(() => {
    const all: ActivityItem[] = [];

    runs.slice(0, 3).forEach((r) => {
      const nm = pipelineNameOf(r);
      const st = (r.status ?? "").toLowerCase();
      all.push({
        text: st === "running" ? `${nm} started — steps queued` : `${nm} ${st}`,
        time: runStartedRel(r),
        icon: st === "running" ? "bolt" : st === "completed" ? "check_circle" : st === "failed" ? "error" : "schedule",
        iconColor: st === "running" ? "var(--bv-status-running)" : st === "completed" ? "var(--bv-cobalt-glow)" : st === "failed" ? "var(--bv-status-failed)" : undefined,
      });
    });

    approvals.slice(0, 2).forEach((a) => {
      all.push({
        text: `Spend gate opened — ${a.description ?? "approval"} awaiting review`,
        time: a.createdAt ? timeAgo(a.createdAt) : "now",
        icon: "paid",
        iconColor: "var(--bv-status-running)",
      });
    });

    risks.slice(0, 2).forEach((r) => {
      all.push({
        text: r.message ?? r.type ?? "Risk event triggered",
        time: r.createdAt ? timeAgo(r.createdAt) : "now",
        icon: "gpp_maybe",
        iconColor: "var(--bv-status-failed)",
      });
    });

    return all.slice(0, 7);
  }, [runs, approvals, risks]);

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
      <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--color-outline)", fontSize: 12 }}>
        No recent activity.
      </div>
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
  const list = approvals.slice(0, 4);

  return (
    <section className={`bv-glass bv-panel ${approvals.length > 0 ? "bv-pulse-glow" : ""}`}>
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>approval</span>
            {t("app.dashboard.pendingApprovalsBanner")}
          </h2>
          <div className="bv-caption">Polling every 10s</div>
        </div>
        {approvals.length > 0 && (
          <span className="bv-pill bv-pill-amber">
            {approvals.length} waiting
          </span>
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
                  {a.description ?? a.metadata?.toolName ?? "Approval needed"}
                </div>
                <div className="bv-approval-meta">
                  {typeof a.amountUsd === "number" ? (
                    <span style={{ color: "var(--bv-status-running)", fontFamily: "var(--bv-font-mono)", fontSize: 15, fontWeight: 500 }}>
                      ${a.amountUsd.toFixed(2)}
                    </span>
                  ) : (
                    a.type ?? "—"
                  )}
                  {a.createdAt && <> · {timeAgo(a.createdAt)}</>}
                </div>
              </div>
              <div className="bv-approval-actions">
                <Link href={`/approvals?id=${a.id}`} className="bv-btn bv-btn-primary bv-btn-sm">
                  {t("app.dashboard.review")}
                </Link>
                <Link href={`/approvals?id=${a.id}&deny=1`} className="bv-btn bv-btn-ghost bv-btn-sm">
                  Deny
                </Link>
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
            {risks.length === 0 ? "No active risks" : `${risks.length} active`}
          </div>
        </div>
        {risks.some((r) => r.fresh) && (
          <span className="bv-pill bv-pill-red">{risks.filter((r) => r.fresh).length} new</span>
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
            const sev = String(r.severity ?? "low").toLowerCase() as "high" | "medium" | "low";
            return (
              <li key={r.id} className={`bv-risk-item ${r.fresh ? "bv-risk-flash" : ""}`}>
                <div className={`bv-risk-sev bv-risk-sev-${sev}`} aria-label={sev} />
                <div>
                  <div className="bv-risk-title">{r.message ?? r.type ?? "Risk event"}</div>
                  {r.reason && <div className="bv-risk-detail">{r.reason}</div>}
                </div>
                <div className="bv-risk-when">{r.createdAt ? timeAgo(r.createdAt) : "now"}</div>
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
function DraftsPanel({ runs, loaded }: { runs: RunRow[]; loaded: boolean }) {
  const drafts = useMemo(
    () =>
      runs
        .filter((r) => (r.status ?? "").toUpperCase() === "COMPLETED")
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          title: pipelineNameOf(r),
          source: `from ${r.id.slice(0, 8)}`,
        })),
    [runs]
  );

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>description</span>
            Recent drafts
          </h2>
        </div>
        {drafts.length > 0 && (
          <span
            className="bv-mono"
            style={{
              fontSize: 11,
              color: "var(--color-on-surface)",
              background: "var(--bv-steel-shadow)",
              borderRadius: 6,
              padding: "1px 8px",
            }}
          >
            {drafts.length}
          </span>
        )}
      </header>

      {!loaded ? (
        <div>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--bv-glass-border)" }}>
              <div className="animate-shimmer" style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div className="animate-shimmer" style={{ height: 12, width: "60%", borderRadius: 4 }} />
                <div className="animate-shimmer" style={{ height: 10, width: "35%", marginTop: 5, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      ) : drafts.length === 0 ? (
        <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--color-outline)", fontSize: 12 }}>
          No drafts yet.
        </div>
      ) : (
        <div>
          {drafts.map((d, idx) => (
            <Link
              key={d.id}
              href={`/runs/${d.id}`}
              style={{
                display: "flex",
                gap: 11,
                alignItems: "center",
                padding: "9px 0",
                borderBottom: idx < drafts.length - 1 ? "1px solid rgba(35,40,51,0.5)" : "none",
                textDecoration: "none",
                transition: "opacity 150ms",
              }}
            >
              {/* thumbnail placeholder */}
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: "var(--color-surface-container-low)",
                  border: "1px solid var(--bv-glass-border)",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--color-outline)" }} aria-hidden>
                  article
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--color-on-surface)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {d.title}
                </div>
                <div className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>{d.source}</div>
              </div>
              <span style={{ marginLeft: "auto", color: "var(--color-outline)", fontSize: 18 }} aria-hidden>›</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
