"use client";

import { useEffect, useState } from "react";

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
 * Real error details still go to console.error → Sentry.
 */

const SAFE_USER_MESSAGES: Array<{ pattern: RegExp; copy: string; cta?: { label: string; href: string } }> = [
  {
    pattern: /unauthorized|unauthenticated|jwt|token expired/i,
    copy: "Your session expired. Please sign in again.",
    cta: { label: "Sign in", href: "/login" },
  },
  {
    pattern: /forbidden|access denied/i,
    copy: "You don't have permission to view this. If this seems wrong, contact support.",
  },
  {
    pattern: /network|fetch|failed to fetch|connection refused/i,
    copy: "We couldn't reach the server. Check your connection and retry.",
  },
  {
    pattern: /rate.?limit|too many requests/i,
    copy: "You're making requests too fast. Please wait a moment and retry.",
  },
  {
    pattern: /timeout|timed out/i,
    copy: "This request took too long to complete. Try again, or check the status page.",
  },
];

function deriveUserMessage(error: Error & { digest?: string }): {
  copy: string;
  cta?: { label: string; href: string };
} {
  const msg = error?.message ?? "";
  for (const { pattern, copy, cta } of SAFE_USER_MESSAGES) {
    if (pattern.test(msg)) return { copy, cta };
  }
  return { copy: "An unexpected error occurred. Our team has been notified." };
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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

  const { copy, cta } = deriveUserMessage(error);
  const reference = error.digest ?? null;

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "#0a0d14" }}
    >
      <div className="text-center max-w-md">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
        >
          <span className="material-symbols-outlined text-3xl" style={{ color: "#f87171" }}>error</span>
        </div>

        <h2 className="font-headline font-bold text-xl mb-2" style={{ color: "#e1e2eb" }}>
          Something went wrong
        </h2>
        <p className="text-sm mb-4" style={{ color: "#859399" }}>
          {copy}
        </p>

        {reference && (
          <p
            className="text-xs mb-6 px-4 py-2 rounded-lg font-mono inline-block"
            style={{ background: "rgba(255,255,255,0.04)", color: "#859399", border: "1px solid rgba(255,255,255,0.08)" }}
            aria-label="Error reference for support"
          >
            Reference: {reference}
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
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
              Try Again
            </button>
          ) : (
            <p className="text-xs" style={{ color: "#859399" }}>
              This error persists. Please go home and try again.
            </p>
          )}
          <a
            href="/"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "#bbc9cf",
              textDecoration: "none",
            }}
          >
            Go Home
          </a>
          {reference && (
            <a
              href={`mailto:support@braavolabs.com?subject=Error%20${encodeURIComponent(reference)}`}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#bbc9cf",
                textDecoration: "none",
              }}
            >
              Contact support
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
