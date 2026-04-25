import { redirect } from "next/navigation";

/**
 * /register is a thin server-side redirect to /login?tab=register.
 *
 * The login page renders both flows behind a tab toggle (the same
 * `mode: "login" | "register"` state). Without this route, every
 * external link to /register returned 404 — emails, social shares,
 * legacy bookmarks, marketing copy — silently breaking the sign-up
 * funnel. Server-side `redirect()` avoids the client-render flash.
 *
 * The `?tab=register` hint is read by login/page.tsx (via
 * `useSearchParams`) to pre-select the Register tab.
 */
export default function RegisterPage() {
  redirect("/login?tab=register");
}
