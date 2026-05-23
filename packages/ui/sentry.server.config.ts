/**
 * Server-side Sentry init — boots when the Node runtime starts via
 * instrumentation.ts. Mirrors the client config but with the more
 * comprehensive default integrations (HTTP, console, unhandled
 * rejection) that only make sense outside the browser.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    release: process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
    // Production-only safety: drop any event whose stack trace looks
    // like a Next.js internal bail-out (NEXT_NOT_FOUND, NEXT_REDIRECT)
    // — these are control-flow exceptions, not real errors.
    ignoreErrors: ["NEXT_NOT_FOUND", "NEXT_REDIRECT", "DYNAMIC_SERVER_USAGE"],
  });
}
