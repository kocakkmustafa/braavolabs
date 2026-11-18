"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { api } from "../../lib/api";
import { buildCatalog, filterCatalog, countByState, type IntegrationRow, type ProviderInfo } from "../../lib/integrationsCatalog";
import { ProviderCard, RequestCard, ErrorBox } from "../../components/integrations/CatalogParts";

type Company = { id: string; name: string };

export default function IntegrationsPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [search, setSearch] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersFailed, setProvidersFailed] = useState(false);
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationRow[] | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const statusRequest = useRef(0);

  // Providers (what can really be connected) + the workspace list.
  useEffect(() => {
    if (!hydrated || !token) return;
    let live = true;
    setProvidersFailed(false);
    api.listProviders(token)
      .then((v) => { if (live) setProviders(Array.isArray(v) ? v : []); })
      .catch(() => { if (live) setProvidersFailed(true); });
    api.listCompanies(token)
      .then((c: Company[]) => {
        if (!live) return;
        const list = Array.isArray(c) ? c : [];
        setCompanies(list);
        setCompanyId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, [hydrated, token, reload]);

  // Connection state for the selected workspace. Failure -> "unknown", never a guess.
  useEffect(() => {
    if (!token || !companyId) { setIntegrations(null); setStatusFailed(false); return; }
    const request = ++statusRequest.current;
    setIntegrations(null);
    setStatusFailed(false);
    api.listIntegrations(token, companyId)
      .then((rows: IntegrationRow[]) => { if (request === statusRequest.current) setIntegrations(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (request === statusRequest.current) setStatusFailed(true); });
  }, [token, companyId, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);
  const catalog = useMemo(() => buildCatalog(providers ?? [], integrations), [providers, integrations]);
  const filtered = useMemo(() => filterCatalog(catalog, search), [catalog, search]);
  const counts = useMemo(() => countByState(catalog), [catalog]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  const loading = providers === null && !providersFailed;

  return (
    <div className="bv-dash max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro mb-1 text-outline">{uiText("m1d31c122563e")}</p>
          <h1 className="bv-headline mb-1">{t("app.integrations.title")}</h1>
          <p className="bv-caption">{t("app.integrations.note")}</p>
        </div>
      </div>

      {/* Import CTA banner */}
      <div className="rounded-xl bg-surface-container-low p-4 flex flex-row items-center gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <p className="bv-title text-on-surface">{uiText("m519d2f226020")}</p>
          <p className="bv-caption mt-0.5">{uiText("m56994963473b")}</p>
        </div>
        <Link href="/integrations/import" className="bv-btn bv-btn-ghost bv-btn-sm flex-none" style={{ minHeight: 44, textDecoration: "none" }}>{uiText("m48f6463ee542")}<span className="material-symbols-outlined" style={{ fontSize: 14 }}>arrow_forward</span>
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <label htmlFor="integration-search" className="sr-only">{t("app.integrations.searchPlaceholder")}</label>
          <input
            id="integration-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("app.integrations.searchPlaceholder")}
            className="w-full px-4 py-2.5 rounded-xl text-sm outline-none bg-surface-container-low text-on-surface placeholder:text-outline focus-visible:ring-2 focus-visible:ring-primary/40"
            style={{ minHeight: 44 }}
          />
        </div>
        {companies && companies.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor="integration-company" className="bv-caption">{t("app.integrations.companyLabel")}</label>
            <select
              id="integration-company"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="rounded-xl text-sm bg-surface-container-low text-on-surface px-3 focus-visible:ring-2 focus-visible:ring-primary/40"
              style={{ minHeight: 44 }}
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}
      </div>

      {providersFailed ? <ErrorBox t={t} body={t("app.integrations.loadError")} onRetry={retry} /> : null}
      {!providersFailed && statusFailed ? <div className="mb-4"><ErrorBox t={t} body={t("app.integrations.statusLoadError")} onRetry={retry} /></div> : null}

      {loading ? (
        <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
          <span className="sr-only">{t("app.integrations.loading")}</span>
        </div>
      ) : null}

      {!loading && !providersFailed ? (
        <>
          <p className="bv-micro mb-4" aria-live="polite">
            {t("app.integrations.resultCountTemplate", { count: filtered.length })}
            {counts.connected > 0 ? ` · ${t("app.integrations.connectedCountTemplate", { count: counts.connected })}` : ""}
          </p>

          {filtered.length > 0 ? (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-8">
              {filtered.map((entry) => <ProviderCard key={entry.provider} entry={entry} t={t} />)}
            </ul>
          ) : (
            <p className="bv-body text-on-surface-variant py-12 text-center">
              {catalog.length === 0 ? t("app.integrations.emptyProviders") : t("app.integrations.noResults")}
            </p>
          )}

          <RequestCard t={t} />
        </>
      ) : null}

    </div>
  );
}
