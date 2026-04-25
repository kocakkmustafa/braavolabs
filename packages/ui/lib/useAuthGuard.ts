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
    // replace, not push — see login/page.tsx for the full reasoning.
    // Symmetrical fix: anonymous user on /dashboard gets bounced to
    // /login. push() leaves /dashboard in history → back-button takes
    // them BACK to /dashboard → useEffect runs again → push /login →
    // infinite forward-back loop, makes the back button feel broken.
    // replace() collapses the redirect so back-button skips both pages.
    if (hydrated && !token) {
      router.replace("/login");
    }
  }, [hydrated, token, router]);

  return { token, hydrated };
}
