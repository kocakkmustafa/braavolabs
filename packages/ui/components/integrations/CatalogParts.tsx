import React from "react";
import Link from "next/link";
import type { CatalogEntry, ConnectionState } from "../../lib/integrationsCatalog";

export type T = (key: string, values?: Record<string, string | number>) => string;

const STATE_KEY: Record<ConnectionState, string> = {
  connected: "statusConnected",
  pending: "statusPending",
  error: "statusError",
  expired: "statusExpired",
  none: "statusNone",
  unknown: "statusUnknown",
};

// Ilık Grafit: no accent, no green. Error uses the existing red pill token;
// every other state is a text weight/colour difference plus the label.
const STATE_CLASS: Record<ConnectionState, string> = {
  connected: "text-on-surface font-medium",
  pending: "text-on-surface-variant",
  error: "bv-pill bv-pill-red",
  expired: "bv-pill bv-pill-amber",
  none: "text-on-surface-variant",
  unknown: "text-on-surface-variant",
};

export function StatusLabel({ state, t }: { state: ConnectionState; t: T }) {
  return (
    <span className={`text-xs flex-none inline-flex items-center gap-1 ${STATE_CLASS[state]}`}>
      {state === "expired" ? <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 14 }}>warning</span> : null}
      {t(`app.integrations.${STATE_KEY[state]}`)}
    </span>
  );
}

export function ProviderCard({ entry, t }: { entry: CatalogEntry; t: T }) {
  const action = entry.state === "connected" || entry.state === "pending" || entry.state === "error" || entry.state === "expired" ? "manage" : "connect";
  return (
    <li className="rounded-xl bg-surface-container-low p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h2 className="bv-title text-sm min-w-0 break-words">{entry.name}</h2>
        <StatusLabel state={entry.state} t={t} />
      </div>
      {entry.description ? <p className="bv-caption line-clamp-2">{entry.description}</p> : null}
      <div className="flex items-center gap-3 mt-auto pt-2">
        <Link
          href="/settings?tab=integrations"
          aria-label={`${t(`app.integrations.${action}`)}: ${entry.name}`}
          className="bv-btn bv-btn-ghost bv-btn-sm"
          style={{ minHeight: 44, textDecoration: "none" }}
        >
          {t(`app.integrations.${action}`)}
        </Link>
        {entry.docsUrl ? (
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${t("app.integrations.docs")}: ${entry.name}`}
            className="text-xs text-on-surface-variant underline inline-flex items-center focus-visible:outline focus-visible:outline-2"
            style={{ minHeight: 44 }}
          >
            {t("app.integrations.docs")}
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function RequestCard({ t }: { t: T }) {
  return (
    <section className="rounded-xl bg-surface-container-low p-4 flex flex-col sm:flex-row sm:items-center gap-3" aria-labelledby="integration-request-title">
      <div className="flex-1 min-w-0">
        <h2 id="integration-request-title" className="bv-title text-sm">{t("app.integrations.requestTitle")}</h2>
        <p className="bv-caption mt-0.5">{t("app.integrations.requestBody")}</p>
      </div>
      <Link href="/contact" className="bv-btn bv-btn-ghost bv-btn-sm flex-none" style={{ minHeight: 44, textDecoration: "none" }}>
        {t("app.integrations.requestCta")}
      </Link>
    </section>
  );
}

export function ErrorBox({ t, body, onRetry }: { t: T; body: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl bg-surface-container-low p-4 flex items-center gap-3">
      <p className="bv-body flex-1">{body}</p>
      <button type="button" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ minHeight: 44 }} onClick={onRetry}>
        {t("app.integrations.retry")}
      </button>
    </div>
  );
}

import type { View } from "../../lib/integrationsPage";

// Everything below the search row: one place that maps page state to markup.
export function CatalogBody({ view, entries, search, statusFailed, connectedCount, t, onRetry }: {
  view: View; entries: CatalogEntry[]; search: string; statusFailed: boolean; connectedCount: number; t: T; onRetry: () => void;
}) {
  if (view === "loading") {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
        <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
        <span className="sr-only">{t("app.integrations.loading")}</span>
      </div>
    );
  }
  if (view === "providersError") return <ErrorBox t={t} body={t("app.integrations.loadError")} onRetry={onRetry} />;
  if (view === "companiesError") return <ErrorBox t={t} body={t("app.integrations.companiesLoadError")} onRetry={onRetry} />;
  const q = search.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)) : entries;
  return (
    <>
      {statusFailed ? <div className="mb-4"><ErrorBox t={t} body={t("app.integrations.statusLoadError")} onRetry={onRetry} /></div> : null}
      {view === "empty" ? (
        <p className="bv-body text-on-surface-variant py-12 text-center">{t("app.integrations.emptyProviders")}</p>
      ) : view === "noCompany" ? (
        <p className="bv-body text-on-surface-variant py-12 text-center">{t("app.integrations.noCompany")}</p>
      ) : (
        <>
          <p className="bv-micro mb-4" aria-live="polite">
            {t("app.integrations.resultCountTemplate", { count: shown.length })}
            {connectedCount > 0 ? ` · ${t("app.integrations.connectedCountTemplate", { count: connectedCount })}` : ""}
          </p>
          {shown.length > 0 ? (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-8">
              {shown.map((entry) => <ProviderCard key={entry.provider} entry={entry} t={t} />)}
            </ul>
          ) : (
            <p className="bv-body text-on-surface-variant py-12 text-center">{t("app.integrations.noResults")}</p>
          )}
        </>
      )}
      <RequestCard t={t} />
    </>
  );
}
