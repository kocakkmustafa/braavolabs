"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useEffect, useState } from "react";
import { classifyFailure, useLocalizedFailure } from "../lib/localized-error";

/**
 * Global error boundary.
 *
 * Earlier this rendered `error.message` raw — Next.js exposes server-side
 * stack traces in `error.message` for unminified builds and propagates them
 * to the client when the UI is rendered. That's both a polish issue (users
 * shouldn't see "TypeError: undefined is not a function at...") and a small
 * info-disclosure surface (paths, internal struct names).
 *
 * Fix: whitelist a small set of safe, user-actionable phrases (auth errors,
 * network errors, etc.) and otherwise show a digest reference users can
 * email support with. Everything else falls back to a generic message.
 * Diagnostics remain in the local console; delivery to an external service is not asserted.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const uiText = useLegacyTranslations("uiCopy");
  const errorCopy = useLegacyTranslations("surface.error");
  const describeFailure = useLocalizedFailure();
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    // Full error → console (and Sentry if it auto-instruments).
    // The user-facing message is intentionally limited to whitelisted phrases.
    console.error("Global error:", error);
  }, [error]);

  const handleReset = () => {
    setRetryCount((c) => c + 1);
    reset();
  };

  const copy = describeFailure(error);
  const cta = classifyFailure(error) === "session" ? { href: "/login", label: errorCopy("signIn") } : null;
  const reference = error.digest ?? null;

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "var(--color-background)" }}
    >
      <div className="text-center max-w-md">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
        >
          <span className="material-symbols-outlined text-3xl" style={{ color: "var(--color-error)" }}>error</span>
        </div>

        <h2 className="font-headline font-bold text-xl mb-2" style={{ color: "var(--color-on-surface)" }}>{uiText("m76d027d04e32")}</h2>
        <p className="text-sm mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
          {copy}
        </p>

        {reference && (
          <p
            className="text-xs mb-6 px-4 py-2 rounded-lg font-mono inline-block"
            style={{ background: "rgba(255,255,255,0.04)", color: "var(--color-on-surface-variant)", border: "1px solid rgba(255,255,255,0.08)" }}
            aria-label={uiText("me06887989706")}
          >{uiText("mc3fca6aef955")}{" "}{reference}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3">
          {cta ? (
            <a
              href={cta.href}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", textDecoration: "none" }}
            >
              {cta.label}
            </a>
          ) : retryCount < 2 ? (
            <button
              onClick={handleReset}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>{uiText("m28a812f120c3")}</button>
          ) : (
            <p className="text-xs" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("m795836a1d4b2")}</p>
          )}
          <a
            href="/"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "var(--color-on-surface-variant)",
              textDecoration: "none",
            }}
          >{uiText("meda5eea8ae48")}</a>
          {reference && (
            <a
              href={`mailto:support@yulalab.com?subject=Error%20${encodeURIComponent(reference)}`}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "var(--color-on-surface-variant)",
                textDecoration: "none",
              }}
            >{uiText("mccfb38fd1109")}</a>
          )}
        </div>
      </div>
    </div>
  );
}
