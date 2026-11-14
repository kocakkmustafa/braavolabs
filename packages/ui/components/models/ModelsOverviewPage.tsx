"use client";
/**
 * BRA-UX-05h — Modeller ve bağlantılar (bayrak `NEXT_PUBLIC_UX_MODELS`). Yalnız var olan uçlar: `GET /companies` (şirket seçici) ve
 * `GET /companies/:id/models` (BRA-UX-API-02, salt-okur). Kaynak veri olmayan her alan (kaynak, erişim kipi, otomatik seçim, maliyet)
 * "Bilinmiyor" okunur; arayüz değer uydurmaz. Anahtar ekleme/yerel model bağlama burada YOK: mevcut Ayarlar'a bağlantı verilir.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore } from "../../lib/store";
import { useDisplayFormats } from "../../lib/useDisplayFormats";
import { formatDateTime, currentTimeZone } from "../../i18n/locales";
import { retryFocusTarget } from "../../lib/ux-models/focus";
import { COST_DISPLAY_FLOOR, isBelowCostPrecision, toOverviewView, type OverviewView } from "../../lib/ux-models/models";

type Company = { id: string; name: string };
type Load = { status: "idle" | "loading" | "ready" | "error"; view: OverviewView | null };

const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const chip: React.CSSProperties = {
  fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "var(--color-surface-container-high)", color: "var(--color-on-surface-variant)",
};
const card: React.CSSProperties = {
  display: "grid", gap: 6, padding: 16, borderRadius: 14, background: "var(--color-surface-container)", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-high)",
};

export default function ModelsOverviewPage() {
  const t = useTranslations();
  const locale = useLocale();
  const displayFormat = useDisplayFormats();
  const { token, hydrated } = useAuthGuard();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const mt = (k: string, v?: Record<string, string | number>) => t(`app.models.${k}`, v);

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companiesFailed, setCompaniesFailed] = useState(false);
  const [companyId, setCompanyId] = useState<string>("");
  const [load, setLoad] = useState<Load>({ status: "idle", view: null });
  const seq = useRef(0);
  const companiesSeq = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const retryPending = useRef(false);

  const loadCompanies = useCallback(() => {
    if (!hydrated || !token) return;
    setCompaniesFailed(false);
    const mine = ++companiesSeq.current;
    api.listCompanies(token)
      .then((rows) => {
        if (mine !== companiesSeq.current) return; // eski oturumun geç yanıtı yeni listeyi ezmez
        const list: Company[] = (Array.isArray(rows) ? rows : [])
          .filter((c) => c && typeof c.id === "string")
          .map((c) => ({ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id }));
        setCompanies(list);
        setCompanyId((cur) => (cur && list.some((c) => c.id === cur) ? cur : list[0]?.id ?? ""));
      })
      .catch(() => { if (mine === companiesSeq.current) setCompaniesFailed(true); });
  }, [token, hydrated, sessionRevision]);
  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  const loadModels = useCallback(() => {
    if (!hydrated || !token || !companyId) return;
    const mine = ++seq.current;
    setLoad((p) => ({ status: "loading", view: p.view }));
    api.getModelsOverview(token, companyId)
      .then((o) => { if (mine === seq.current) setLoad({ status: "ready", view: toOverviewView(o) }); })
      // Başka şirkete geçildiyse eski şirketin satırları kalmaz: hata durumunda görünüm sıfırlanır.
      .catch(() => { if (mine === seq.current) setLoad({ status: "error", view: null }); });
  }, [token, hydrated, companyId]);
  useEffect(() => { setLoad({ status: "idle", view: null }); loadModels(); }, [loadModels]);

  // "Tekrar dene" sonrası odak: tıklamada sonuç alanına; sonuç/hata gelince bkz. retryFocusTarget.
  useEffect(() => {
    const target = retryFocusTarget(retryPending.current, load.status);
    if (!target) return;
    retryPending.current = false;
    (target === "retry" ? retryRef.current : resultsRef.current)?.focus();
  }, [load.status]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,122,26,0.3)", borderTopColor: "#FF7A1A" }} />
      </div>
    );
  }

  const view = load.view;
  const unknown = mt("unknown");
  const when = (v: string | null) => (v ? formatDateTime(v, locale, { timeZone: currentTimeZone(), dateStyle: "medium", timeStyle: "short" }) : null);
  const autoText = view?.autoSelection === true ? mt("autoOn") : view?.autoSelection === false ? mt("autoOff") : unknown;
  const noCompanies = companies !== null && companies.length === 0;

  return (
    <div data-testid="models-page" className="max-w-3xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="bv-headline text-on-surface">{mt("title")}</h1>
        <p className="bv-caption mt-1">{mt("subtitle")}</p>
      </header>

      {companies && companies.length > 0 && (
        <label style={{ display: "grid", gap: 4, marginBottom: 20, maxWidth: 360, minWidth: 0 }}>
          <span style={muted}>{mt("company")}</span>
          <select
            data-testid="models-company" value={companyId} onChange={(e) => { retryPending.current = false; setLoad({ status: "idle", view: null }); setCompanyId(e.target.value); }}
            style={{ width: "100%", minWidth: 0, minHeight: 44, padding: "0 12px", borderRadius: 10, background: "var(--color-surface-container)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-high)" }}
          >
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}

      <p role="status" aria-live="polite" className="sr-only" data-testid="models-live">
        {load.status === "ready" && view ? mt("live", { count: view.rows.length }) : ""}
      </p>

      {(companiesFailed || load.status === "error") && (
        <div role="alert" data-testid="models-error" className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.22)", color: "#FF8A8A", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <p style={{ fontWeight: 700, margin: 0 }}>{mt("errorTitle")}</p>
            <p style={{ margin: 0 }}>{mt("errorBody")}</p>
          </div>
          <button ref={retryRef} type="button" className="bv-btn bv-btn-primary bv-btn-sm" onClick={() => { resultsRef.current?.focus(); if (companiesFailed) loadCompanies(); else { retryPending.current = true; loadModels(); } }}>{mt("retry")}</button>
        </div>
      )}

      {noCompanies && (
        <div data-testid="models-no-company" className="bv-glass rounded-2xl py-12 px-6 text-center">
          <p className="bv-title mb-1">{mt("noCompanyTitle")}</p>
          <p className="bv-caption">{mt("noCompanyBody")}</p>
        </div>
      )}

      <div ref={resultsRef} tabIndex={-1} data-testid="models-results" style={{ outline: "none" }}>
      {companyId && load.status === "loading" && !view && <div role="status" className="bv-caption text-center py-12">{mt("loading")}</div>}

      {view && (
        <section aria-label={mt("title")}>
          <p data-testid="models-auto" style={{ ...muted, marginBottom: 12 }}>
            <strong style={{ color: "var(--color-on-surface)" }}>{mt("autoLabel")}</strong>{mt("pairSep")}{autoText}
          </p>

          {view.rows.length === 0 ? (
            <div data-testid="models-empty" className="bv-glass rounded-2xl py-12 px-6 text-center">
              <p className="bv-title mb-1">{mt("emptyTitle")}</p>
              <p className="bv-caption">{mt("emptyBody")}</p>
            </div>
          ) : (
            <ul data-testid="models-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {view.rows.map((r) => (
                <li key={r.id} data-testid={`model-row-${r.id}`} style={card}>
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 16, fontWeight: 600, overflowWrap: "anywhere", fontFamily: r.displayName ? undefined : "var(--font-mono, monospace)" }}>{r.displayName ?? r.id}</span>
                    <span style={chip}>{mt("source.label")}{mt("labelSep")}{mt(`source.${r.source}`)}</span>
                  </span>
                  <span style={muted}>{mt("provider")}{mt("labelSep")}{r.provider ?? unknown}</span>
                  <span style={muted} data-testid={`model-access-${r.id}`}>
                    {mt("access")}{mt("labelSep")}{r.scope === "unknown" ? unknown : mt(`scope.${r.scope}`)}{mt("pairSep")}{r.mode === "unknown" ? unknown : mt(`mode.${r.mode}`)}
                  </span>
                  <span style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline", ...muted }}>
                    <span data-testid={`model-cost-${r.id}`}>
                      {mt("cost")}{mt("labelSep")}
                      <span className={r.cost === null ? undefined : "bv-numeric"} style={r.cost === null ? undefined : { fontSize: 18, color: "var(--bv-status-running)" }}>
                        {r.cost === null ? unknown : isBelowCostPrecision(r.cost) ? `< ${displayFormat.usd(COST_DISPLAY_FLOOR)}` : displayFormat.usd(r.cost)}
                      </span>
                    </span>
                    <span data-testid={`model-runs-${r.id}`}>{r.runCount === null ? `${mt("runs")}${mt("labelSep")}${unknown}` : mt("runCount", { count: r.runCount })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p data-testid="models-cost-note" style={{ ...muted, marginTop: 12 }}>
            {mt("costNote")}{when(view.costFrom) ? ` ${mt("costSince", { from: when(view.costFrom) as string })}` : ""}
            {when(view.generatedAt) ? ` ${mt("updatedAt", { time: when(view.generatedAt) as string })}` : ""}
          </p>
        </section>
      )}

      </div>

      <nav aria-label={mt("linksTitle")} className="mt-8">
        <h2 className="bv-title mb-2">{mt("linksTitle")}</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {([
            ["own", "/settings"], ["local", "/settings"], ["compare", "/compare"], ["connections", "/connections"], ["integrations", "/integrations"],
          ] as const).map(([k, href]) => (
            <li key={k}>
              <Link href={href} data-testid={`models-link-${k}`} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 44, textDecoration: "none" }}>
                <span>
                  <span style={{ fontWeight: 600 }}>{mt(`links.${k}.title`)}</span>
                  <span style={{ ...muted, display: "block" }}>{mt(`links.${k}.body`)}</span>
                </span>
                <span aria-hidden="true">{locale === "ar" ? "‹" : "›"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
