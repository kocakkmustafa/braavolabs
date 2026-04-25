"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "../../../lib/store";

function CallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAppStore((s) => s.setAuth);

  useEffect(() => {
    const token = searchParams.get("token");
    const refreshToken = searchParams.get("refreshToken");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setAuth(token, payload.tenantId, refreshToken ?? undefined);
        // Remove tokens from URL before navigating to prevent them from
        // appearing in browser history, server logs, or Referer headers.
        window.history.replaceState({}, "", "/auth/callback");
        // replace, not push — back-button after OAuth shouldn't take
        // the user back to /auth/callback (a stale URL with consumed
        // tokens). Skip the callback page in history entirely.
        router.replace("/dashboard");
      } catch {
        router.replace("/login");
      }
    } else {
      router.replace("/login");
    }
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
