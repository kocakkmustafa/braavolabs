/**
 * Edge-runtime Sentry init — used by middleware.ts and edge route
 * handlers. We don't currently ship any edge routes but the file
 * keeps withSentryConfig happy and is ready when we do.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    release: process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
  });
}
