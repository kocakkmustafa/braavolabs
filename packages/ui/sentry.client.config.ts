/**
 * Browser-side Sentry init. Loaded automatically by withSentryConfig
 * during build, runs once per page load. Reads the public DSN baked
 * into the bundle at build time via NEXT_PUBLIC_SENTRY_DSN.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Keep the sample rate low — traces are the most expensive event
    // type per Sentry's pricing. 5 % matches the API service default
    // set in env.ts (SENTRY_TRACES_SAMPLE_RATE).
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    // Session replay disabled by default — costly and only useful for
    // visual bug triage. Flip on per-environment when needed.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Tag every event with the build SHA so we can link an error to
    // the exact code revision that emitted it without leaning on the
    // (less reliable) auto-detected release.
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
    // Strip query strings from URLs before they leave the browser —
    // CSRF state tokens and OAuth codes occasionally land in the
    // referrer / current URL and we don't want them in Sentry.
    beforeSend(event) {
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url);
          u.search = "";
          event.request.url = u.toString();
        } catch {
          /* not a parseable URL — leave it alone */
        }
      }
      return event;
    },
  });
}
