"use client";
/**
 * BRA-P0-11d — Şirket "tek bakış" kartı. Uç: `GET /companies/:id/summary`. Kaynağı olmayan alan "Bilinmiyor" (0 değil).
 * Durumlar: yükleniyor / hata (yeniden dene) / boş (gövde okunamadı) / hazır. Stil: mevcut bv-* sınıfları ve tema değişkenleri.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore } from "../../lib/store";
import { useDisplayFormats } from "../../lib/useDisplayFormats";
import { toCompanySummaryView, type CompanySummaryView } from "../../lib/company-summary/view";

type Load = { status: "loading" | "error" | "empty" | "ready"; view: CompanySummaryView | null };

const card: React.CSSProperties = {
  display: "grid", gap: 14, padding: 16, borderRadius: 14, background: "var(--color-surface-container)", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-high)",
};
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };

export default function CompanySummaryCard({ companyId }: { companyId: string }) {
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const fmt = useDisplayFormats();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const ct = (k: string, v?: Record<string, string | number>) => t(`app.companySummary.${k}`, v);
  const [load, setLoad] = useState<Load>({ status: "loading", view: null });
  const seq = useRef(0);

  const ctrl = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    ctrl.current?.abort();
    if (!hydrated || !token || !companyId) return;
    const mine = ++seq.current;
    const ac = new AbortController();
    ctrl.current = ac;
    setLoad({ status: "loading", view: null });
    api.getCompanySummary(token, companyId, ac.signal)
      .then((data) => { if (mine === seq.current && !ac.signal.aborted) setLoad(data ? { status: "ready", view: toCompanySummaryView(data) } : { status: "empty", view: null }); })
      .catch(() => { if (mine === seq.current && !ac.signal.aborted) setLoad({ status: "error", view: null }); }); // iptal edilen istek hata göstermez
  }, [token, hydrated, companyId, sessionRevision]);
  useEffect(() => { refresh(); return () => { seq.current++; ctrl.current?.abort(); }; }, [refresh]);

  const unknown = ct("unknown");
  const num = (n: number | null) => (n === null ? unknown : fmt.number(n, 0));
  const usd = (v: string | null) => (v === null || !Number.isFinite(Number(v)) ? unknown : fmt.usd(v));
  const v = load.view;

  return (
    <section aria-labelledby="company-sum-h" data-testid="company-summary-card" className="mb-6" style={card} aria-busy={load.status === "loading"}>
      <h2 id="company-sum-h" className="bv-title" style={{ margin: 0 }}>{ct("title")}</h2>

      {load.status === "loading" && <p role="status" style={muted} data-testid="company-summary-loading">{ct("loading")}</p>}

      {load.status === "error" && (
        <div role="alert" data-testid="company-summary-error" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 200px" }}>{ct("error")}</span>
          <button type="button" className="bv-btn bv-btn-primary bv-btn-sm" onClick={refresh}>{ct("retry")}</button>
        </div>
      )}

      {load.status === "empty" && <p role="status" style={muted} data-testid="company-summary-empty">{ct("empty")}</p>}

      {load.status === "ready" && v && (
        <>
          <dl data-testid="company-summary-stats" style={{ margin: 0, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
            {v.buckets.map((b) => (
              <div key={b.key} data-testid={`company-summary-bucket-${b.key}`}>
                <dt style={muted}>{ct(`bucket.${b.key}`)}</dt>
                <dd style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{num(b.count)}</dd>
              </div>
            ))}
            <div data-testid="company-summary-approvals">
              <dt style={muted}>{ct("pendingApprovals")}</dt>
              <dd style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{num(v.pendingApprovals)}</dd>
            </div>
            <div data-testid="company-summary-agents">
              <dt style={muted}>{ct("agents")}</dt>
              <dd style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{num(v.agents)}</dd>
            </div>
            <div data-testid="company-summary-pipelines">
              <dt style={muted}>{ct("pipelines")}</dt>
              <dd style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{num(v.pipelines)}</dd>
            </div>
            <div data-testid="company-summary-cost">
              <dt style={muted}>{ct("monthCost")}</dt>
              <dd style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{usd(v.monthCostUsd)}</dd>
            </div>
          </dl>

          {v.budget === null ? (
            <div data-testid="company-summary-budget" style={{ display: "grid", gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{ct("budget.title")}</span>
              <p style={muted} data-testid="company-summary-budget-unknown">{unknown}</p>
            </div>
          ) : (
          <div data-testid="company-summary-budget" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{ct("budget.title")}</span>
              <span className={`bv-pill bv-pill-${v.budget.tone}`} data-testid="company-summary-budget-badge" data-state={v.budget.state}>
                {ct(`budget.state.${v.budget.labelKey}`)}
              </span>
            </div>
            {v.budget.barPct !== null && (
              <div
                role="progressbar" aria-label={ct("budget.title")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.budget.barPct)}
                aria-valuetext={v.budget.usedPct === null ? ct("budget.state.over") : ct("budget.used", { pct: fmt.number(v.budget.usedPct, 1) })}
                data-testid="company-summary-budget-bar"
                style={{ height: 8, borderRadius: 999, background: "var(--color-surface-container-high)", overflow: "hidden" }}
              >
                <div className={`bv-pill-${v.budget.tone}`} style={{ height: "100%", width: `${v.budget.barPct}%`, background: "currentColor", border: 0 }} />
              </div>
            )}
            {v.budget.state === "none" ? (
              <p style={muted} data-testid="company-summary-budget-none">{ct("budget.noneHint")}</p>
            ) : (
              <p style={muted} data-testid="company-summary-budget-line">
                {ct("budget.spent")} <bdi>{usd(v.budget.spentUsd)}</bdi> · {ct("budget.limit")} <bdi>{usd(v.budget.limitUsd)}</bdi> · {ct("budget.remaining")} <bdi>{usd(v.budget.remainingUsd)}</bdi>
                {v.budget.usedPct !== null ? ` · ${ct("budget.used", { pct: fmt.number(v.budget.usedPct, 1) })}` : ""}
              </p>
            )}
          </div>
          )}
        </>
      )}
    </section>
  );
}
