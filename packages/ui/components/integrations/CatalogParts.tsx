import React from "react";
import Link from "next/link";
import type { CatalogEntry, ConnectionState } from "../../lib/integrationsCatalog";

export type T = (key: string, values?: Record<string, string | number>) => string;

const STATE_KEY: Record<ConnectionState, string> = {
  connected: "statusConnected",
  pending: "statusPending",
  error: "statusError",
  none: "statusNone",
  unknown: "statusUnknown",
};

// Ilık Grafit: no accent, no green. Error uses the existing red pill token;
// every other state is a text weight/colour difference plus the label.
const STATE_CLASS: Record<ConnectionState, string> = {
  connected: "text-on-surface font-medium",
  pending: "text-on-surface-variant",
  error: "bv-pill bv-pill-red",
  none: "text-on-surface-variant",
  unknown: "text-on-surface-variant",
};

export function StatusLabel({ state, t }: { state: ConnectionState; t: T }) {
  return <span className={`text-xs flex-none ${STATE_CLASS[state]}`}>{t(`app.integrations.${STATE_KEY[state]}`)}</span>;
}

export function ProviderCard({ entry, t }: { entry: CatalogEntry; t: T }) {
  const action = entry.state === "connected" || entry.state === "pending" || entry.state === "error" ? "manage" : "connect";
  return (
    <li className="rounded-xl bg-surface-container-low p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h2 className="bv-title text-sm min-w-0 break-words">{entry.name}</h2>
        <StatusLabel state={entry.state} t={t} />
      </div>
      {entry.description ? <p className="bv-caption line-clamp-2">{entry.description}</p> : null}
      <div className="flex items-center gap-3 mt-auto pt-2">
        <Link
          href="/settings"
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
