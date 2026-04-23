/**
 * Sentry error reporting (OPS-NEW-003 launch blocker).
 *
 * Wires @sentry/node so any uncaught exception, unhandled promise rejection,
 * and explicit `captureException()` call lands in the Sentry project pointed
 * to by `SENTRY_DSN`. When the env var is not set we no-op — local dev and
 * the test runner don't need the SDK active.
 *
 * Initialization MUST happen before the rest of the app loads so the
 * Sentry instrumentation can patch the http/express modules. See index.ts.
 */

import * as Sentry from "@sentry/node";
import type { ErrorRequestHandler, RequestHandler } from "express";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Silent no-op — keeps local dev frictionless. Production deploys MUST
    // set SENTRY_DSN; the launch checklist (README) flags this.
    return;
  }
  if (initialized) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE ?? process.env.npm_package_version ?? "0.0.0",
    // Sample 100% of errors. Sample traces sparingly (5%) — they're cheap
    // per event but add up under load. Override via env if you want more.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip the credential-shaped header values defense-in-depth — the
      // pino-http redactor already does this for logs but Sentry collects
      // its own request snapshot.
      const headers = event.request?.headers;
      if (headers) {
        for (const key of Object.keys(headers)) {
          if (/authorization|cookie|api[_-]?key|x-webhook-signature/i.test(key)) {
            headers[key] = "[REDACTED]";
          }
        }
      }
      return event;
    },
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

/**
 * Express middleware that captures errors thrown by downstream handlers.
 * Mount BEFORE the application's error handler so Sentry sees the error
 * before the handler responds and resets the request context.
 */
export const sentryRequestHandler: RequestHandler = (req, _res, next) => {
  if (!initialized) return next();
  Sentry.withScope((scope) => {
    scope.setTag("requestId", (req as { id?: string }).id ?? "unknown");
    scope.setTag("path", req.path);
    next();
  });
};

export const sentryErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (initialized) {
    Sentry.captureException(err);
  }
  next(err);
};

/** Re-export captureException so callers don't need to import @sentry/node directly. */
export const captureException = (err: unknown, context?: Record<string, unknown>): void => {
  if (!initialized) return;
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value as never);
      }
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
};
