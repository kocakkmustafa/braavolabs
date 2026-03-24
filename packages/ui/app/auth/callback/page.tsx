"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "../../../lib/store";

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAppStore((s) => s.setAuth);

  useEffect(() => {
    const token = searchParams.get("token");
    if (token) {
      // Decode JWT to get tenantId
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setAuth(token, payload.tenantId);
        router.push("/");
      } catch {
        router.push("/login");
      }
    } else {
      router.push("/login");
    }
  }, [searchParams, setAuth, router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-900">
      <div className="text-white text-lg">Signing in...</div>
    </div>
  );
}
