/**
 * Next.js 15 instrumentation hook — boots the Sentry SDK on the server
 * and edge runtimes before the first request is handled.
 *
 * The browser SDK lives in `sentry.client.config.ts` (loaded by
 * withSentryConfig automatically). This file only covers Node + edge
 * because Next.js 15 dropped the standalone `sentry.server.config.ts`
 * convention in favour of the instrumentation hook.
 *
 * Sentry DSN is read from NEXT_PUBLIC_SENTRY_DSN so the same value
 * compiles into the client bundle and runs on the server — keeping a
 * single source of truth and matching the prod env layout. When the
 * value is empty (dev, self-hosted operator who hasn't opted in) the
 * SDK no-ops and never makes a network call.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Re-export onRequestError so server-component / route-handler errors
// flow into Sentry with the request context attached. Without this
// hook, RSC errors only land in the standard console output.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
