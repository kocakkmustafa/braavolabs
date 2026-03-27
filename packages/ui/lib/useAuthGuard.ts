"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "./store";

/**
 * Waits for Zustand hydration before checking auth.
 * Returns { token, hydrated } — render a loader until hydrated is true.
 * If hydrated and no token → redirects to /login.
 */
export function useAuthGuard() {
  const token = useAppStore((s) => s.token);
  const hydrated = useAppStore((s) => s._hydrated);
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !token) {
      router.push("/login");
    }
  }, [hydrated, token, router]);

  return { token, hydrated };
}
