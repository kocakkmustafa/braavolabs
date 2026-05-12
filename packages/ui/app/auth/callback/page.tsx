"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "../../../lib/store";
import { api } from "../../../lib/api";

function CallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAppStore((s) => s.setAuth);

  useEffect(() => {
    const exchangeCode = searchParams.get("code");
    // Legacy fallback for any in-flight redirects from older API
    // releases that still embed the bearer token in the URL. Once the
    // new server has been live for >24h the fallback can be deleted.
    const legacyToken = searchParams.get("token");
    const legacyRefresh = searchParams.get("refreshToken");

    let cancelled = false;
    async function run() {
      try {
        if (exchangeCode) {
          // Scrub the URL BEFORE the network call so the code can't be
          // leaked to Referer headers from any dashboard navigation
          // that happens while the exchange is in-flight.
          window.history.replaceState({}, "", "/auth/callback");
          const bundle = await api.exchangeOAuthCode(exchangeCode);
          if (cancelled) return;
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
        if (!cancelled) router.replace("/login");
      }
    }
    run();
    return () => { cancelled = true; };
  }, [searchParams, setAuth, router]);

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: "#0a0d14" }}>
      <div className="text-sm" style={{ color: "#bbc9cf" }}>Signing in...</div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen" style={{ background: "#0a0d14" }}>
        <div className="text-sm" style={{ color: "#bbc9cf" }}>Loading...</div>
      </div>
    }>
      <CallbackInner />
    </Suspense>
  );
}
