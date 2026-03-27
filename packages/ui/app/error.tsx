"use client";

import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    console.error("Global error:", error);
  }, [error]);

  const handleReset = () => {
    setRetryCount((c) => c + 1);
    reset();
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "#10131a" }}
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
        <p className="text-sm mb-2" style={{ color: "#859399" }}>
          An unexpected error occurred. Our team has been notified.
        </p>
        {error.message && (
          <p
            className="text-xs mb-6 px-4 py-2 rounded-lg font-mono"
            style={{ background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.15)" }}
          >
            {error.message}
          </p>
        )}

        <div className="flex items-center justify-center gap-3">
          {retryCount < 2 ? (
            <button
              onClick={handleReset}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
              Try Again
            </button>
          ) : (
            <p className="text-xs mb-2" style={{ color: "#859399" }}>
              This error persists. Please go home and try again.
            </p>
          )}
          <a
            href="/"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf", textDecoration: "none" }}
          >
            Go Home
          </a>
        </div>
      </div>
    </div>
  );
}
