"use client";
/**
 * BRA-UX-05f — Şirket durumu (bayrak `NEXT_PUBLIC_UX_COMPANY`). Tek satır özet + ajanlar. Yalnız var olan uçlar: `GET /companies/:id`
 * ve `GET /runs?bucket=…` (şirket kimliğiyle istemcide süzülür). Okunamayan kova "Bilinmiyor", kısmi sayfa "en az N"; sayılar uydurulmaz.
 * Ekip, risk ve entegrasyon durumu için bu yüzeyde veri YOK: mevcut sayfalara bağlantı verilir.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore } from "../../lib/store";
import { useDisplayFormats } from "../../lib/useDisplayFormats";
import {
  SUMMARY_BUCKETS, companyName, summarizeCompany, toAgentRows, type BucketPages, type SummaryBucket,
} from "../../lib/ux-company/summary";

type Load = { status: "loading" | "ready" | "error"; name: string | null; agents: ReturnType<typeof toAgentRows>; pages: BucketPages | null };
const EMPTY_PAGES: BucketPages = { working: null, stuck: null, needs_approval: null, done: null };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const card: React.CSSProperties = {
  display: "grid", gap: 6, padding: 16, borderRadius: 14, background: "var(--color-surface-container)", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-high)",
};

export default function CompanyStatus() {
  const t = useTranslations();
  const displayFormat = useDisplayFormats();
  const params = useParams();
  const companyId = String(params?.id ?? "");
  const { token, hydrated } = useAuthGuard();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const ct = (k: string, v?: Record<string, string | number>) => t(`app.companyStatus.${k}`, v);
  const [load, setLoad] = useState<Load>({ status: "loading", name: null, agents: [], pages: null });
  const seq = useRef(0);

  const refresh = useCallback(() => {
    if (!hydrated || !token || !companyId) return;
    const mine = ++seq.current;
    setLoad({ status: "loading", name: null, agents: [], pages: null });
    const buckets = Promise.all(SUMMARY_BUCKETS.map((b) => api.inboxRuns(token, b).then((p) => p, () => null)));
    Promise.all([api.getCompany(token, companyId), buckets])
      .then(([company, results]) => {
        if (mine !== seq.current) return;
        const pages = { ...EMPTY_PAGES };
        SUMMARY_BUCKETS.forEach((b, i) => { pages[b] = results[i]; });
        setLoad({ status: "ready", name: companyName(company), agents: toAgentRows(company), pages });
      })
      // Şirket okunamazsa (yok/yetkisiz/ağ) sayılar GÖSTERİLMEZ: kova sonuçları tek başına şirket adını/ajanları vermez.
      .catch(() => { if (mine === seq.current) setLoad({ status: "error", name: null, agents: [], pages: null }); });
  }, [token, hydrated, companyId, sessionRevision]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,122,26,0.3)", borderTopColor: "#FF7A1A" }} />
      </div>
    );
  }

  const summary = load.pages ? summarizeCompany(companyId, load.pages) : null;
  const unknown = ct("unknown");
  const countText = (b: SummaryBucket) => {
    const c = summary?.counts[b];
    if (!c || c.count === null) return unknown;
    return c.partial ? ct("atLeast", { count: c.count }) : String(c.count);
  };
  const costText = !summary ? unknown : summary.costUsd === null ? unknown : displayFormat.usd(summary.costUsd);
  const stuck = summary?.counts.stuck.count ?? null;
  const approvals = summary?.counts.needs_approval.count ?? null;

  return (
    <div data-testid="company-status" className="max-w-3xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="bv-headline text-on-surface" style={{ overflowWrap: "anywhere" }}>{load.name ?? ct("title")}</h1>
        <p className="bv-caption mt-1">{ct("subtitle")}</p>
      </header>

      <p role="status" aria-live="polite" className="sr-only" data-testid="company-live">
        {load.status === "ready" && summary ? ct("live", { approvals: approvals ?? 0, stuck: stuck ?? 0 }) : ""}
      </p>

      {load.status === "error" && (
        <div role="alert" data-testid="company-error" className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.22)", color: "#FF8A8A", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <p style={{ fontWeight: 700, margin: 0 }}>{ct("errorTitle")}</p>
            <p style={{ margin: 0 }}>{ct("errorBody")}</p>
          </div>
          <button type="button" className="bv-btn bv-btn-primary bv-btn-sm" onClick={refresh}>{ct("retry")}</button>
        </div>
      )}
      {load.status === "loading" && <div role="status" className="bv-caption text-center py-12">{ct("loading")}</div>}

      {load.status === "ready" && summary && (
        <>
          <section aria-label={ct("summaryLabel")} data-testid="company-summary" style={card}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }} data-testid="company-summary-line">
              {ct("working")} {countText("working")} · {ct("stuck")} {countText("stuck")} · {ct("approvals")} {countText("needs_approval")} · {ct("done")} {countText("done")} · {ct("cost")} {costText}
            </p>
            <p style={muted} data-testid="company-summary-note">
              {ct("note")}
              {summary.costUnknownRuns > 0 ? ` ${ct("costUnknownRuns", { count: summary.costUnknownRuns })}` : ""}
            </p>
          </section>

          <section aria-labelledby="company-agents-h" className="mt-6">
            <h2 id="company-agents-h" className="bv-title mb-2">{ct("agents")}</h2>
            {load.agents.length === 0 ? (
              <p data-testid="company-agents-empty" style={muted}>{ct("agentsEmpty")}</p>
            ) : (
              <ul data-testid="company-agents" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {load.agents.map((a) => (
                  <li key={a.id} data-testid={`company-agent-${a.id}`} style={card}>
                    <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{a.name}</span>
                    <span style={muted}>{ct("role")}: {a.role ?? unknown}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <nav aria-label={ct("linksTitle")} className="mt-8">
        <h2 className="bv-title mb-2">{ct("linksTitle")}</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {([
            ["jobs", "/inbox"], ["approvals", "/approvals"], ["risks", "/risks"], ["integrations", "/integrations"], ["classic", `/companies/${encodeURIComponent(companyId)}`],
          ] as const).map(([k, href]) => (
            <li key={k}>
              <Link href={href} data-testid={`company-link-${k}`} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 44, textDecoration: "none" }}>
                <span>
                  <span style={{ fontWeight: 600 }}>{ct(`links.${k}.title`)}</span>
                  <span style={{ ...muted, display: "block" }}>{ct(`links.${k}.body`)}</span>
                </span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
