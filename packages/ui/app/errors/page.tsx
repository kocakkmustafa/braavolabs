"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

interface FailedRun {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  pipeline: {
    name: string;
    company: { id: string; name: string };
  };
  _count: { steps: number };
}

const RISK_BADGE_STYLES: Record<string, { background: string; color: string; border: string }> = {
  "governance.hard_stop": { background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)" },
  "governance.loop_stop": { background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.25)" },
  "governance.cost_anomaly_stop": { background: "rgba(251,191,36,0.08)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
  "governance.spam_stop": { background: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "1px solid rgba(109,17,173,0.3)" },
  "governance.brand_violation_stop": { background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
};

const DEFAULT_BADGE = { background: "rgba(133,147,153,0.12)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

export default function ErrorsPage() {
  const t = useTranslations();
  const token = useAppStore((s) => s.token);
  const router = useRouter();
  const [runs, setRuns] = useState<FailedRun[]>([]);
  const [riskEvents, setRiskEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      router.replace("/login");
      return;
    }
    Promise.all([
      api.listRuns(token, 100, 0).then((data) => {
        const failed = (data.runs ?? []).filter(
          (r: any) => r.status === "FAILED" || r.status === "CANCELLED",
        );
        setRuns(failed);
      }).catch(() => {}),
      api.riskEvents(token, 50).then(setRiskEvents).catch(() => setRiskEvents([])),
    ]).finally(() => setLoading(false));
  }, [token, router]);

  if (!token) return null;

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
        <div className="h-8 w-48 rounded-lg animate-shimmer" />
        <div className="h-20 rounded-2xl animate-shimmer" />
        <div className="h-20 rounded-2xl animate-shimmer" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">

      {/* ── Page head ─────────────────────────────────────────── */}
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-1">
          Governance
        </p>
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-error" style={{ fontSize: 28 }}>
            error
          </span>
          <h1 className="text-2xl font-bold text-on-surface" style={{ fontFamily: "var(--font-headline)", letterSpacing: "-0.01em" }}>
            {t("app.errors.title")}
          </h1>
        </div>
        <p className="text-sm text-on-surface-variant mt-1">{t("app.errors.subtitle")}</p>
      </div>

      {/* ── Failed Runs section ───────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 18 }}>
            cancel
          </span>
          <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wider">
            {t("app.errors.failedSectionTemplate", { count: runs.length })}
          </h2>
        </div>

        {runs.length > 0 ? (
          <div className="flex flex-col gap-3 stagger-children">
            {runs.map((run) => (
              <Link
                key={run.id}
                href={`/companies/${run.pipeline?.company?.id}/runs/${run.id}`}
                className="glass-card card-glass-hover block p-4 no-underline group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* status dot */}
                    <span
                      className="flex-shrink-0 w-2 h-2 rounded-full"
                      style={{
                        background: run.status === "FAILED" ? "#f87171" : "#9AA3B2",
                        boxShadow: run.status === "FAILED" ? "0 0 6px rgba(239,68,68,0.5)" : "none",
                      }}
                    />
                    <span className="font-semibold text-on-surface text-sm truncate">
                      {run.pipeline?.name ?? t("app.errors.unknown")}
                    </span>
                    {run.pipeline?.company?.name && (
                      <span className="text-on-surface-variant text-xs hidden sm:inline">
                        {run.pipeline.company.name}
                      </span>
                    )}
                    {/* status pill */}
                    <span
                      className="flex-shrink-0 text-xs font-semibold px-2.5 py-0.5 rounded-full"
                      style={
                        run.status === "FAILED"
                          ? { background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }
                          : { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" }
                      }
                    >
                      {run.status}
                    </span>
                  </div>

                  <div className="text-right flex-shrink-0 ml-4">
                    <p className="text-xs text-on-surface-variant">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--color-outline)" }}>
                      {run._count?.steps ?? 0} {t("app.errors.stepsLabel")}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="glass-card p-12 text-center">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)" }}
            >
              <span className="material-symbols-outlined" style={{ color: "#34d399", fontSize: 24 }}>
                check_circle
              </span>
            </div>
            <p className="font-semibold text-on-surface">{t("app.errors.noFailedTitle")}</p>
            <p className="text-sm text-on-surface-variant mt-1">{t("app.errors.noFailedBody")}</p>
          </div>
        )}
      </section>

      {/* ── Risk Events section ───────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 18 }}>
            shield
          </span>
          <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wider">
            {t("app.errors.riskSectionTemplate", { count: riskEvents.length })}
          </h2>
        </div>

        {riskEvents.length > 0 ? (
          <div className="flex flex-col gap-3 stagger-children">
            {riskEvents.map((event: any) => {
              const badge = RISK_BADGE_STYLES[event.action] ?? DEFAULT_BADGE;
              return (
                <div key={event.id} className="glass-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* risk action pill */}
                      <span
                        className="text-xs font-semibold px-2.5 py-0.5 rounded-full flex-shrink-0"
                        style={badge}
                      >
                        {event.action}
                      </span>
                      {event.resourceId && (
                        <span className="text-xs font-mono" style={{ color: "var(--color-outline)" }}>
                          {event.resourceId.slice(0, 8)}&hellip;
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-on-surface-variant flex-shrink-0 ml-4">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>

                  {event.details && (
                    <pre
                      className="mt-3 text-xs rounded-lg overflow-auto"
                      style={{
                        color: "var(--color-on-surface-variant)",
                        background: "rgba(0,0,0,0.3)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        padding: "10px 12px",
                        maxHeight: 120,
                        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
                      }}
                    >
                      {JSON.stringify(event.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="glass-card p-12 text-center">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.15)" }}
            >
              <span className="material-symbols-outlined" style={{ color: "var(--color-primary)", fontSize: 24 }}>
                verified_user
              </span>
            </div>
            <p className="font-semibold text-on-surface">{t("app.errors.noRiskTitle")}</p>
            <p className="text-sm text-on-surface-variant mt-1">{t("app.errors.noRiskBody")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
