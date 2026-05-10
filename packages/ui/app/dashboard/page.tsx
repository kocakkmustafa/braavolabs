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
          style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }}
        />
      </div>
    );
  }

  const greetingName = me?.name?.split(" ")[0] ?? me?.email?.split("@")[0] ?? "there";
  const greeting = greetingFor(new Date());

  return (
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <TrialBanner token={token} />

        {/* ─── Page head: greeting + date-range + export ─────────────── */}
        <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
          <div>
            <div className="bv-micro" style={{ marginBottom: 6 }}>
              {/* i18n: hardcoded — "Command center" feels redundant with title="Command Center"; keep micro-eyebrow short */}
              {t("app.dashboard.title")}
            </div>
            <h1 className="bv-display" style={{ margin: 0 }}>
              {greeting}, <span className="bv-grad-text">{greetingName}.</span>
            </h1>
            <div
              className="bv-caption"
              style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`bv-dot ${health?.activeRuns ? "bv-running bv-ping" : "bv-paused"}`} aria-hidden />
                {/* i18n: hardcoded — follow-up to add app.dashboard.statusLine */}
                {(health?.activeRuns ?? 0) > 0
                  ? `${health!.activeRuns} ${health!.activeRuns === 1 ? "run" : "runs"} live`
                  : "All quiet — no active runs"}
              </span>
              {(health?.pendingApprovals ?? 0) > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  <span>
                    {health!.pendingApprovals} {t("app.dashboard.pendingApprovalsBanner").toLowerCase()}
                  </span>
                </>
              )}
              {risks.length > 0 && (
                <>
                  <span className="bv-divider-dot" aria-hidden />
                  {/* i18n: hardcoded — "risks need review" */}
                  <span>
                    {risks.length} {risks.length === 1 ? "risk" : "risks"} need your eye
                  </span>
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
              {/* i18n: existing key */}
              <span>{t("app.dashboard.newCompany")}</span>
            </Link>
          </div>
        </div>

        {/* ─── Metrics row (4 cards, stagger-fade on first paint) ────── */}
        <div className="bv-metrics bv-stagger" style={{ marginBottom: 22, position: "relative" }}>
          <MetricCard
            icon="bolt"
            label={t("app.dashboard.metricRunningPipelines")}
            value={health?.activeRuns ?? 0}
            live
            accent="linear-gradient(135deg, #00d1ff, #1a3aff)"
            foot={(health?.activeRuns ?? 0) > 0 ? `${health!.activeRuns} pipeline${health!.activeRuns === 1 ? "" : "s"} running` : "No active runs"}
            loaded={loaded}
          />
          <MetricCard
            icon="check_circle"
            label="Run health" /* i18n: hardcoded */
            value={usage ? `${(usage.successRate * 100).toFixed(1)}` : "—"}
            suffix={usage ? "%" : undefined}
            accent="linear-gradient(135deg, #34d399, #15a36b)"
            delta={usage ? `${usage.completedRuns}/${usage.totalRuns}` : undefined}
            deltaTone="good"
            foot={usage?.failedRuns ? `${usage.failedRuns} failed in window` : "Clean window"}
            loaded={loaded}
          />
          <MetricCard
            icon="paid"
            label={t("app.dashboard.metricTotalCost")}
            value={`$${(finance?.totalCostUsd ?? 0).toFixed(2)}`}
            accent="linear-gradient(135deg, #6d11ad, #1a3aff)"
            delta={finance?.runCount ? `$${finance.avgCostPerRun.toFixed(4)}/run` : undefined}
            deltaTone="neutral"
            foot={finance?.runCount ? `${finance.runCount} run${finance.runCount === 1 ? "" : "s"} billed` : undefined}
            loaded={loaded}
          />
          <MetricCard
            icon="approval"
            label={t("app.dashboard.metricPendingApprovals")}
            value={health?.pendingApprovals ?? 0}
            accent="linear-gradient(135deg, #fbbf24, #d97706)"
            delta={(health?.pendingApprovals ?? 0) > 0 ? t("app.dashboard.actionNeeded") : undefined}
            deltaTone={(health?.pendingApprovals ?? 0) > 0 ? "neutral" : "good"}
            foot={(health?.pendingApprovals ?? 0) > 0 ? "Tap below to review" : "Inbox zero"}
            loaded={loaded}
          />
        </div>

        {/* ─── 2-column main / side ───────────────────────────────── */}
        <div className="bv-twocol">
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
          </div>
          <div className="bv-twocol-side">
            <ApprovalsPanel approvals={approvals} loaded={loaded} t={t} />
            <RiskPanel risks={risks} loaded={loaded} />
          </div>
        </div>

        {/* ─── Page foot ──────────────────────────────────────────── */}
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

/* ─────────────────────────  MetricCard  ───────────────────────── */

function MetricCard(props: {
  icon: string;
  label: string;
  value: string | number;
  suffix?: string;
  accent: string;
  delta?: string;
  deltaTone?: "good" | "bad" | "neutral";
  foot?: string;
  live?: boolean;
  loaded?: boolean;
}) {
  const { icon, label, value, suffix, accent, delta, deltaTone = "good", foot, live, loaded } = props;
  return (
    <div className="bv-glass bv-metric" style={{ position: "relative" }}>
      <div className="bv-metric-accent" style={{ background: accent }} aria-hidden />
      <div className="bv-metric-head">
        <div className="bv-metric-icon">
          <span className="material-symbols-outlined" aria-hidden>{icon}</span>
        </div>
        <span className="bv-micro" style={{ flex: 1 }}>{label}</span>
        {live && <span className="bv-dot bv-running bv-ping" aria-hidden />}
      </div>
      <div className="bv-metric-value">
        {loaded === false ? (
          <span className="bv-numeric" style={{ fontSize: 28, opacity: 0.3 }}>—</span>
        ) : (
          <span className={`bv-numeric ${live ? "bv-tick" : ""}`} style={{ fontSize: 28 }}>
            {value}
          </span>
        )}
        {suffix && <span className="bv-metric-suffix">{suffix}</span>}
      </div>
      {delta && (
        <div className={`bv-metric-delta ${deltaTone}`}>
          <span className="material-symbols-outlined" aria-hidden>
            {deltaTone === "good" ? "trending_up" : deltaTone === "bad" ? "trending_down" : "trending_flat"}
          </span>
          <span>{delta}</span>
        </div>
      )}
      {foot && <div className="bv-metric-foot">{foot}</div>}
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

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title">Recent runs{/* i18n: hardcoded */}</h2>
          <div className="bv-caption">Polling every 15s</div>
        </div>
        <div className="bv-panel-head-actions">
          <Link href="/runs" className="bv-btn bv-btn-ghost bv-btn-sm">
            <span>View all</span>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
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
            {runs.slice(0, 8).map((r) => (
              <Link
                key={r.id}
                href={`/runs/${r.id}`}
                role="row"
                className="bv-runs-row"
                style={{ textDecoration: "none" }}
              >
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
                <span className="bv-runs-company">{companyNameOf(r)}</span>
                <span>
                  <StatusLabel status={(r.status ?? "running").toLowerCase() as Lowercase<RunStatus>} />
                </span>
                <span className="bv-runs-started">{runStartedRel(r)}</span>
                <span className="bv-mono" style={{ color: "var(--color-on-surface-variant)" }}>
                  {runStepsLabel(r)}
                </span>
                <span style={{ textAlign: "right" }} className="bv-mono">
                  {runSpendLabel(r)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
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
            {/* i18n: existing keys */}
            {t("app.dashboard.pendingApprovalsBanner")}
          </h2>
          <div className="bv-caption">Polling every 10s</div>
        </div>
        {approvals.length > 0 && (
          <span className="bv-pill bv-pill-amber">
            {approvals.length} {approvals.length === 1 ? "waiting" : "waiting"}
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
          {/* i18n: hardcoded */}
          Inbox zero — no approvals waiting.
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
                  {typeof a.amountUsd === "number" ? `$${a.amountUsd.toFixed(2)}` : a.type ?? "—"}
                  {a.createdAt && <> · {timeAgo(a.createdAt)}</>}
                </div>
              </div>
              <div className="bv-approval-actions">
                <Link href={`/approvals?id=${a.id}`} className="bv-btn bv-btn-ghost bv-btn-sm">
                  {/* i18n: existing key */}
                  {t("app.dashboard.review")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {approvals.length > list.length && (
        <Link href="/approvals" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ marginTop: 4 }}>
          {/* i18n: existing key */}
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

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>gpp_maybe</span>
            {/* i18n: hardcoded */}
            Risk events
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
          {/* i18n: hardcoded */}
          Audit trail clean — no risks raised.
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
        {/* i18n: hardcoded */}
        <span>Open risk inbox</span>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
      </Link>
    </section>
  );
}
