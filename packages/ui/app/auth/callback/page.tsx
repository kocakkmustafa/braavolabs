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
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setAuth(token, payload.tenantId);
        router.push("/dashboard");
      } catch {
        router.push("/login");
      }
    } else {
      router.push("/login");
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
