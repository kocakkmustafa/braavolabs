"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { captureAuthSession, isAuthSessionCurrent, useAppStore } from "../../../lib/store";
import { api } from "../../../lib/api";

const FORGE_MSGS = [
  "Verifying with provider…",
  "Establishing secure session…",
  "Loading your workspaces…",
  "Almost there…",
];

function ForgeLoader({ msg }: { msg: string }) {
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="mesh-bg min-h-screen flex flex-col items-center justify-center bg-background overflow-hidden">
      {/* ambient glow backdrop */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 40%, rgba(59,130,246,0.07) 0%, transparent 70%)",
        }}
      />

      {/* forge spinner + wordmark */}
      <div className="relative z-10 flex flex-col items-center gap-6 text-center px-5 animate-scale-in">
        {/* spinning rings */}
        <div className="relative w-36 h-36 flex items-center justify-center">
          {/* outer arc ring */}
          <span
            className="absolute inset-0 rounded-full"
            style={{
              border: "2px solid var(--color-surface-container-high)",
              borderTopColor: "var(--color-primary)",
              borderRightColor: "var(--color-secondary)",
              animation: "spin 1s linear infinite",
              boxShadow: "0 0 24px -6px var(--color-primary)",
            }}
          />
          {/* inner counter-ring */}
          <span
            className="absolute rounded-full"
            style={{
              inset: "18px",
              border: "1.5px solid transparent",
              borderBottomColor: "var(--color-primary-container)",
              animation: "spin 1.5s linear infinite reverse",
            }}
          />
          {/* emblem */}
          <span
            className="material-symbols-outlined text-primary"
            style={{
              fontSize: "2.75rem",
              filter: "drop-shadow(0 0 16px rgba(59,130,246,0.5))",
              fontVariationSettings: "'FILL' 1, 'wght' 300, 'GRAD' 0, 'opsz' 48",
            }}
          >
            bolt
          </span>
        </div>

        {/* wordmark */}
        <div className="flex flex-col items-center gap-1.5">
          <p
            className="font-headline text-xl font-semibold tracking-tight uppercase gradient-text"
          >{uiText("m1b78e46f051f")}</p>
          {/* cycling status message */}
          <p
            className="font-mono text-xs tracking-widest text-on-surface-variant transition-opacity duration-300"
            style={{ fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)" }}
          >
            {msg}
          </p>
        </div>

        {/* progress bar */}
        <div
          className="w-48 h-px rounded-full overflow-hidden"
          style={{ background: "var(--color-surface-container-high)" }}
        >
          <div
            className="h-full animate-shimmer"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, var(--color-primary) 50%, transparent 100%)",
              backgroundSize: "200% 100%",
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function CallbackInner() {
  const router = useRouter();
  const t = useTranslations();
  const searchParams = useSearchParams();
  // Next synchronizes searchParams when history.replaceState scrubs the URL.
  // Capture the callback once so that scrub cannot cancel the pending exchange.
  const [callbackParams] = useState(() => ({
    exchangeCode: searchParams.get("code"),
    legacyToken: searchParams.get("token"),
    legacyRefresh: searchParams.get("refreshToken"),
  }));
  const [initialSession] = useState(captureAuthSession);
  const exchangePromise = useRef<ReturnType<typeof api.exchangeOAuthCode> | null>(null);
  const setAuth = useAppStore((s) => s.setAuth);
  const [msgIndex, setMsgIndex] = useState(0);

  // cycle status messages while the exchange is in-flight
  useEffect(() => {
    const iv = setInterval(() => {
      setMsgIndex((i) => (i + 1 < FORGE_MSGS.length ? i + 1 : i));
    }, 900);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const { exchangeCode, legacyToken, legacyRefresh } = callbackParams;
    // Legacy fallback for any in-flight redirects from older API
    // releases that still embed the bearer token in the URL. Once the
    // new server has been live for >24h the fallback can be deleted.
    let cancelled = false;
    async function run() {
      try {
        if (!isAuthSessionCurrent(initialSession)) return;
        if (exchangeCode) {
          // Scrub the URL BEFORE the network call so the code can't be
          // leaked to Referer headers from any dashboard navigation
          // that happens while the exchange is in-flight.
          window.history.replaceState({}, "", "/auth/callback");
          // StrictMode may repeat the effect before this one-time code resolves.
          exchangePromise.current ??= api.exchangeOAuthCode(exchangeCode);
          const bundle = await exchangePromise.current;
          if (cancelled || !isAuthSessionCurrent(initialSession)) return;
          setAuth(bundle.token, bundle.tenant.id, bundle.refreshToken);
        } else if (legacyToken) {
          const payload = JSON.parse(atob(legacyToken.split(".")[1]));
          setAuth(legacyToken, payload.tenantId, legacyRefresh ?? undefined);
          window.history.replaceState({}, "", "/auth/callback");
        } else {
          router.replace("/login");
          return;
        }
        // replace, not push — back-button after OAuth shouldn't take
        // the user back to /auth/callback (a stale URL with a consumed
        // code). Skip the callback page in history entirely.
        router.replace("/dashboard");
      } catch {
        if (!cancelled && isAuthSessionCurrent(initialSession)) router.replace("/login");
      }
    }
    run();
    return () => { cancelled = true; };
  }, [callbackParams, initialSession, setAuth, router]);

  void t; // t is available for future i18n expansion; FORGE_MSGS used directly per mock style
  return <ForgeLoader msg={FORGE_MSGS[msgIndex]} />;
}

export default function AuthCallbackPage() {
  const t = useTranslations();
  void t;
  return (
    <Suspense fallback={<ForgeLoader msg={FORGE_MSGS[0]} />}>
      <CallbackInner />
    </Suspense>
  );
}
