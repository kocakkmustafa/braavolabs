"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { api } from "../../lib/api";
import { countByState, type IntegrationRow } from "../../lib/integrationsCatalog";
import { reducer, initialState, viewOf, entriesOf, type Company } from "../../lib/integrationsPage";
import { CatalogBody } from "../../components/integrations/CatalogParts";

export default function IntegrationsPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [search, setSearch] = useState("");
  const [state, dispatch] = useReducer(reducer, initialState);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!hydrated || !token) return;
    let live = true;
    dispatch({ type: "reload" });
    api.listProviders(token)
      .then((v) => { if (live) dispatch({ type: "providers", providers: Array.isArray(v) ? v : [] }); })
      .catch(() => { if (live) dispatch({ type: "providersFailed" }); });
    api.listCompanies(token)
      .then((c: Company[]) => { if (live) dispatch({ type: "companies", companies: Array.isArray(c) ? c : [] }); })
      .catch(() => { if (live) dispatch({ type: "companiesFailed" }); });
    return () => { live = false; };
  }, [hydrated, token, reload]);

  // Status call only with a company; the reducer drops answers for a company that is no longer selected.
  const { companyId } = state;
  useEffect(() => {
    if (!token || !companyId) return;
    api.listIntegrations(token, companyId)
      .then((rows: IntegrationRow[]) => dispatch({ type: "status", companyId, rows: Array.isArray(rows) ? rows : [] }))
      .catch(() => dispatch({ type: "statusFailed", companyId }));
  }, [token, companyId, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);
  const view = viewOf(state);
  const entries = useMemo(() => entriesOf(state), [state]);
  const connectedCount = useMemo(() => countByState(entries).connected, [entries]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

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
        {state.companies && state.companies.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor="integration-company" className="bv-caption">{t("app.integrations.companyLabel")}</label>
            <select
              id="integration-company"
              value={state.companyId}
              onChange={(e) => dispatch({ type: "selectCompany", companyId: e.target.value })}
              className="rounded-xl text-sm bg-surface-container-low text-on-surface px-3 focus-visible:ring-2 focus-visible:ring-primary/40"
              style={{ minHeight: 44 }}
            >
              {state.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}
      </div>

      <CatalogBody view={view} entries={entries} search={search} statusFailed={state.statusFailed} connectedCount={connectedCount} t={t} onRetry={retry} />

    </div>
  );
}
