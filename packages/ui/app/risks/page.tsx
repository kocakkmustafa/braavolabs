"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

// Color palette stays static — only the human-readable label localises
// at render time, keyed off the action string returned by the API.
const RISK_STYLES: Record<string, { labelKey: string; bg: string; color: string; border: string }> = {
  "governance.hard_stop": { labelKey: "labelHardStop", bg: "rgba(239,68,68,0.1)", color: "#f87171", border: "rgba(239,68,68,0.2)" },
  "governance.loop_stop": { labelKey: "labelLoopDetected", bg: "rgba(249,115,22,0.1)", color: "#fb923c", border: "rgba(249,115,22,0.2)" },
  "governance.cost_anomaly_stop": { labelKey: "labelCostAnomaly", bg: "rgba(251,191,36,0.1)", color: "#fbbf24", border: "rgba(251,191,36,0.2)" },
  "governance.spam_stop": { labelKey: "labelSpamProtection", bg: "rgba(168,85,247,0.1)", color: "#c084fc", border: "rgba(168,85,247,0.2)" },
  "governance.brand_violation_stop": { labelKey: "labelBrandViolation", bg: "rgba(236,72,153,0.1)", color: "#f472b6", border: "rgba(236,72,153,0.2)" },
  "run.failed": { labelKey: "labelRunFailed", bg: "rgba(239,68,68,0.1)", color: "#f87171", border: "rgba(239,68,68,0.2)" },
  "run.stop": { labelKey: "labelRunStopped", bg: "rgba(133,147,153,0.1)", color: "#859399", border: "rgba(133,147,153,0.2)" },
};

export default function RisksPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [events, setEvents] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [tab, setTab] = useState<"risks" | "activity">("risks");

  useEffect(() => {
    if (!token) return;
    api.riskEvents(token).then(setEvents).catch(() => {});
    api.activityLog(token, 100).then((res) => setActivityLogs(res.logs)).catch(() => {});
  }, [token]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: "#0a0d14" }}>
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold font-headline gradient-text">{t("app.risks.title")}</h1>
        <p className="text-sm mt-0.5" style={{ color: "#859399" }}>{t("app.risks.subtitle")}</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 stagger-children">
        {[
          { label: t("app.risks.statsTotalRisk"), value: events.length, color: "#f87171" },
          { label: t("app.risks.statsLoopStops"), value: events.filter((e) => e.action === "governance.loop_stop").length, color: "#fb923c" },
          { label: t("app.risks.statsCostAnomalies"), value: events.filter((e) => e.action === "governance.cost_anomaly_stop").length, color: "#fbbf24" },
          { label: t("app.risks.statsFailedRuns"), value: events.filter((e) => e.action === "run.failed").length, color: "#859399" },
        ].map((card) => (
          <div key={card.label} className="metric-card rounded-2xl p-5">
            <p className="text-xs font-semibold tracking-widest mb-1" style={{ color: "#859399" }}>{card.label}</p>
            <p className="text-2xl font-bold font-headline" style={{ color: card.color }}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {(["risks", "activity"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className="px-4 py-2.5 text-sm font-medium -mb-px transition-all"
            style={{
              borderBottom: tab === tabKey ? "2px solid #00d1ff" : "2px solid transparent",
              color: tab === tabKey ? "#00d1ff" : "#859399",
            }}
          >
            {tabKey === "risks" ? `${t("app.risks.tabRisks")} (${events.length})` : `${t("app.risks.tabActivity")} (${activityLogs.length})`}
          </button>
        ))}
      </div>

      {tab === "risks" ? (
        events.length === 0 ? (
          <div className="glass-card rounded-2xl text-center py-16">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)" }}
            >
              <span className="material-symbols-outlined text-xl" style={{ color: "#34d399" }}>verified_user</span>
            </div>
            <p className="font-semibold" style={{ color: "#bbc9cf" }}>{t("app.risks.emptyRisksTitle")}</p>
            <p className="text-sm mt-1" style={{ color: "#859399" }}>{t("app.risks.emptyRisksBody")}</p>
          </div>
        ) : (
          <div className="glass-card rounded-2xl overflow-hidden">
            {events.map((e, i) => {
              const style = RISK_STYLES[e.action];
              const label = style ? t(`app.risks.${style.labelKey}`) : e.action;
              const info = style ?? { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "rgba(133,147,153,0.2)" };
              return (
                <div
                  key={e.id ?? i}
                  className="px-6 py-4"
                  style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.06)" : "none" }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{ background: info.bg, color: info.color, border: `1px solid ${info.border}` }}
                      >
                        {label}
                      </span>
                      <span className="text-sm" style={{ color: "#bbc9cf" }}>
                        {e.resource}: {e.resourceId?.slice(0, 8) ?? "—"}
                      </span>
                    </div>
                    <span className="text-xs" style={{ color: "#3c494e" }}>
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {e.details && (
                    <p className="text-xs mt-1" style={{ color: "#859399" }}>
                      {typeof e.details === "string" ? e.details : JSON.stringify(e.details)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        activityLogs.length === 0 ? (
          <div className="glass-card rounded-2xl text-center py-16">
            <p style={{ color: "#859399" }}>{t("app.risks.emptyActivity")}</p>
          </div>
        ) : (
          <div className="glass-card rounded-2xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <tr>
                  {[t("app.risks.thAction"), t("app.risks.thResource"), t("app.risks.thActor"), t("app.risks.thTime")].map((h) => (
                    <th key={h} className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activityLogs.map((log, i) => (
                  <tr
                    key={log.id ?? i}
                    className="interactive-row"
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td className="px-6 py-3">
                      <span
                        className="font-mono text-xs px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.06)", color: "#bbc9cf" }}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3" style={{ color: "#bbc9cf" }}>
                      {log.resource} {log.resourceId ? `(${log.resourceId.slice(0, 8)})` : ""}
                    </td>
                    <td className="px-6 py-3" style={{ color: "#859399" }}>{log.actor?.slice(0, 8) ?? t("app.risks.actorSystem")}</td>
                    <td className="px-6 py-3" style={{ color: "#3c494e" }}>{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
