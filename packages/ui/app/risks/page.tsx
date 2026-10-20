"use client";
import { useLocale as useDisplayLocale } from "next-intl";
import { formatDateTime as formatDisplayDateTime, currentTimeZone as displayTimeZone } from "../../i18n/locales";

import { useTranslations as useLegacyTranslations } from "next-intl";


import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

// Color palette stays static — only the human-readable label localises
// at render time, keyed off the action string returned by the API.
const RISK_STYLES: Record<string, {
  labelKey: string;
  pillClass: string;
  dotClass: string;
  borderColor: string;
  filterKey: string;
}> = {
  "governance.hard_stop":        { labelKey: "labelHardStop",        pillClass: "bv-pill bv-pill-red",    dotClass: "bv-dot bv-failed bv-ping",   borderColor: "#FF4D4D", filterKey: "hard"  },
  "governance.loop_stop":        { labelKey: "labelLoopDetected",     pillClass: "bv-pill bv-pill-amber",  dotClass: "bv-dot bv-running bv-ping",  borderColor: "#FF7A1A", filterKey: "loop"  },
  "governance.cost_anomaly_stop":{ labelKey: "labelCostAnomaly",      pillClass: "bv-pill bv-pill-amber",  dotClass: "bv-dot bv-running",          borderColor: "#FF7A1A", filterKey: "cost"  },
  "governance.spam_stop":        { labelKey: "labelSpamProtection",   pillClass: "bv-pill bv-pill-cyan",   dotClass: "bv-dot bv-completed",        borderColor: "#60A5FA", filterKey: "spam"  },
  "governance.brand_violation_stop":{ labelKey: "labelBrandViolation",pillClass: "bv-pill bv-pill-red",   dotClass: "bv-dot bv-failed bv-ping",   borderColor: "#FF4D4D", filterKey: "brand" },
  "run.failed":                  { labelKey: "labelRunFailed",        pillClass: "bv-pill bv-pill-red",    dotClass: "bv-dot bv-failed",           borderColor: "#FF4D4D", filterKey: "hard"  },
  "run.stop":                    { labelKey: "labelRunStopped",       pillClass: "bv-pill bv-pill-muted",  dotClass: "bv-dot bv-cancelled",        borderColor: "#5B6473", filterKey: "hard"  },
};

const FILTER_KEYS = ["all", "hard", "loop", "cost", "spam", "brand"] as const;
type FilterKey = typeof FILTER_KEYS[number];

const FILTER_LABELS: Record<FilterKey, string> = {
  all:   "All",
  hard:  "hard-stop",
  loop:  "loop-stop",
  cost:  "cost-stop",
  spam:  "spam-check",
  brand: "brand-stop",
};

const FILTER_DOT: Record<FilterKey, string> = {
  all:   "",
  hard:  "bv-dot bv-failed",
  loop:  "bv-dot bv-running bv-ping",
  cost:  "bv-dot bv-running",
  spam:  "bv-dot bv-completed",
  brand: "bv-dot bv-failed",
};

export default function RisksPage() {
  const displayLocale = useDisplayLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [events, setEvents] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [tab, setTab] = useState<"risks" | "activity">("risks");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;
    api.riskEvents(token).then(setEvents).catch(() => {});
    api.activityLog(token, 100).then((res) => setActivityLogs(res.logs)).catch(() => {});
  }, [token]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--color-background)]">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  const toggleOpen = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredEvents = events.filter((e) => {
    if (filter === "all") return true;
    const style = RISK_STYLES[e.action];
    return style?.filterKey === filter;
  });

  const countFor = (f: FilterKey) => {
    if (f === "all") return events.length;
    return events.filter((e) => RISK_STYLES[e.action]?.filterKey === f).length;
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">

      {/* Page head */}
      <div className="mb-8">
        <p className="bv-micro text-[var(--color-outline)] mb-2 tracking-widest">{uiText("m94c28a73da37")}</p>
        <h1 className="bv-headline bv-grad-text mb-1">{t("app.risks.title")}</h1>
        <p className="bv-body text-[var(--color-on-surface-variant)]">{t("app.risks.subtitle")}</p>
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8 bv-stagger">
        {[
          {
            label: t("app.risks.statsTotalRisk"),
            value: events.length,
            icon: "security",
            dotClass: "bv-dot bv-failed",
          },
          {
            label: t("app.risks.statsLoopStops"),
            value: events.filter((e) => e.action === "governance.loop_stop").length,
            icon: "replay",
            dotClass: "bv-dot bv-running bv-ping",
          },
          {
            label: t("app.risks.statsCostAnomalies"),
            value: events.filter((e) => e.action === "governance.cost_anomaly_stop").length,
            icon: "attach_money",
            dotClass: "bv-dot bv-running",
          },
          {
            label: t("app.risks.statsFailedRuns"),
            value: events.filter((e) => e.action === "run.failed").length,
            icon: "cancel",
            dotClass: "bv-dot bv-cancelled",
          },
        ].map((card) => (
          <div key={card.label} className="bv-glass p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className={card.dotClass} />
              <span className="bv-micro">{card.label}</span>
            </div>
            <p className="bv-display bv-numeric text-[var(--color-on-surface)]">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[var(--color-outline-variant)]">
        {(["risks", "activity"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className="px-4 py-2.5 bv-body font-medium -mb-px transition-all"
            style={{
              borderBottom: tab === tabKey ? "2px solid #60A5FA" : "2px solid transparent",
              color: tab === tabKey ? "var(--color-primary)" : "var(--color-on-surface-variant)",
            }}
          >
            {tabKey === "risks"
              ? `${t("app.risks.tabRisks")} (${events.length})`
              : `${t("app.risks.tabActivity")} (${activityLogs.length})`}
          </button>
        ))}
      </div>

      {tab === "risks" ? (
        <>
          {/* Filter chips */}
          <div className="flex flex-wrap gap-2 mb-6">
            {FILTER_KEYS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`bv-fpill${filter === f ? " active" : ""}`}
              >
                {f !== "all" && <span className={FILTER_DOT[f]} />}
                {FILTER_LABELS[f]}
                <span className="bv-fpill-count">{countFor(f)}</span>
              </button>
            ))}
          </div>

          {/* Risk event feed */}
          {filteredEvents.length === 0 ? (
            <div className="bv-glass rounded-2xl text-center py-16">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-[rgba(59,130,246,0.10)] border border-[rgba(59,130,246,0.20)]">
                <span className="material-symbols-outlined text-xl text-[#60A5FA]">verified_user</span>
              </div>
              <p className="bv-title mb-1">{t("app.risks.emptyRisksTitle")}</p>
              <p className="bv-caption">{t("app.risks.emptyRisksBody")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-w-[840px]">
              {filteredEvents.map((e, i) => {
                const style = RISK_STYLES[e.action];
                const label = style ? t(`app.risks.${style.labelKey}`) : e.action;
                const isOpen = openIds.has(e.id ?? String(i));
                const borderColor = style?.borderColor ?? "#5B6473";
                const pillClass = style?.pillClass ??"bv-pill bv-pill-muted";
                const dotClass = style?.dotClass ??"bv-dot bv-cancelled";
                return (
                  <div
                    key={e.id ?? i}
                    className="bv-glass overflow-hidden cursor-pointer"
                    style={{ borderInlineStart: `2px solid ${borderColor}`, borderRadius: "16px" }}
                    onClick={() => toggleOpen(e.id ?? String(i))}
                  >
                    {/* Row head */}
                    <div className="flex items-center gap-3 px-5 py-4">
                      <span className={dotClass} />
                      <span className={pillClass}>{label}</span>
                      <span className="bv-body text-[var(--color-on-surface)] flex-1 truncate">
                        {e.resource}: {e.resourceId?.slice(0, 8) ?? "—"}
                      </span>
                      <span className="bv-mono text-[var(--color-outline)] whitespace-nowrap">
                        {formatDisplayDateTime(e.createdAt, displayLocale, { timeZone: displayTimeZone(), hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span
                        className="material-symbols-outlined text-[var(--color-outline)] text-base transition-transform duration-200"
                        style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
                      >
                        chevron_right
                      </span>
                    </div>

                    {/* Expandable context */}
                    {isOpen && (
                      <div
                        className="border-t border-[var(--color-outline-variant)] px-5 py-4"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        {e.details && (
                          <pre className="bv-mono text-[var(--color-on-surface-variant)] bg-[var(--color-surface-container-low)] border border-[var(--color-outline-variant)] rounded-xl p-3 mb-4 whitespace-pre-wrap leading-relaxed overflow-x-auto">
                            {typeof e.details === "string" ? e.details : JSON.stringify(e.details, null, 2)}
                          </pre>
                        )}
                        <div className="flex items-center gap-3">
                          <button className="bv-btn bv-btn-ghost bv-btn-sm">
                            <span className="material-symbols-outlined text-sm">check_circle</span>{uiText("m9d899093d41e")}</button>
                          <Link
                            href={`/runs/${e.resourceId ?? ""}`}
                            className="bv-mono text-[#60A5FA] ml-auto hover:underline text-xs flex items-center gap-1"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            <span className="material-symbols-outlined text-sm">open_in_new</span>
                            {e.resourceId?.slice(0, 8) ?? e.resource}
                          </Link>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        activityLogs.length === 0 ? (
          <div className="bv-glass rounded-2xl text-center py-16">
            <p className="bv-caption">{t("app.risks.emptyActivity")}</p>
          </div>
        ) : (
          <div className="bv-glass overflow-hidden overflow-x-auto">
            <table className="w-full bv-body">
              <thead className="border-b border-[var(--color-outline-variant)]">
                <tr>
                  {[t("app.risks.thAction"), t("app.risks.thResource"), t("app.risks.thActor"), t("app.risks.thTime")].map((h) => (
                    <th key={h} className="text-left px-6 py-3 bv-micro text-[var(--color-outline)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activityLogs.map((log, i) => (
                  <tr
                    key={log.id ?? i}
                    className="interactive-row border-t border-[var(--color-outline-variant)]"
                  >
                    <td className="px-6 py-3">
                      <span className="bv-mono bg-[var(--color-surface-container-low)] text-[var(--color-on-surface)] px-2 py-0.5 rounded-md">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-[var(--color-on-surface)]">
                      {log.resource} {log.resourceId ? `(${log.resourceId.slice(0, 8)})` : ""}
                    </td>
                    <td className="px-6 py-3 text-[var(--color-on-surface-variant)]">
                      {log.actor?.slice(0, 8) ?? t("app.risks.actorSystem")}
                    </td>
                    <td className="px-6 py-3 bv-mono text-[var(--bv-text-faint)]">
                      {formatDisplayDateTime(log.createdAt, displayLocale, { timeZone: displayTimeZone(), dateStyle: "medium", timeStyle: "short" })}
                    </td>
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
