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
import { ZodError } from "zod";
import { AppError } from "../middleware/error";

let initialized = false;

const SENTRY_REDACTED = "[REDACTED]";
const MIN_PROPAGATED_SECRET_LENGTH = 8;

/**
 * Sentry receives richer data than the application logger: request bodies,
 * exception strings, breadcrumbs and tracing spans can all contain the same
 * store credential. Keep the key list compact and credential-only so useful
 * operational context survives the scrub.
 */
const SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "xhealthprobekey",
  "xwebhooksignature",
  "stripesignature",
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "receipt",
  "receiptdata",
  "purchasetoken",
  "originaltransactionid",
  "privatekey",
  "sharedsecret",
  "clientsecret",
  "credential",
  "credentials",
  "serviceaccount",
  "serviceaccountjson",
  "googleplayserviceaccountjson",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "authorization",
  "cookie",
  "apikey",
  "token",
  "receipt",
  "purchasetoken",
  "originaltransactionid",
  "privatekey",
  "sharedsecret",
  "clientsecret",
  "credentials",
  "serviceaccount",
  "serviceaccountjson",
];

const INLINE_CREDENTIAL_KEY =
  "(?:receipt(?:[_-]?data)?|purchase[_-]?token|original[_-]?transaction[_-]?id|private[_-]?key|" +
  "service[_-]?account(?:[_-]?json)?|google[_-]?play[_-]?service[_-]?account[_-]?json|" +
  "access[_-]?token|refresh[_-]?token|api[_-]?key|shared[_-]?secret|client[_-]?secret|" +
  "authorization|password)";

const DOUBLE_QUOTED_INLINE_CREDENTIAL = new RegExp(
  `(["']?${INLINE_CREDENTIAL_KEY}["']?\\s*[:=]\\s*)"([^"]*)"`,
  "gi",
);
const SINGLE_QUOTED_INLINE_CREDENTIAL = new RegExp(
  `(["']?${INLINE_CREDENTIAL_KEY}["']?\\s*[:=]\\s*)'([^']*)'`,
  "gi",
);
const UNQUOTED_INLINE_CREDENTIAL = new RegExp(
  `(["']?${INLINE_CREDENTIAL_KEY}["']?\\s*[:=]\\s*)([^\\s,}&#"']+)`,
  "gi",
);
const URL_QUERY_CREDENTIAL = new RegExp(
  `((?:^|[?&])${INLINE_CREDENTIAL_KEY}=)([^&#\\s"']*)`,
  "gi",
);

/** Provider API paths whose final component is itself a store credential. */
const PROVIDER_URL_CREDENTIALS = [
  /(\/inApps\/v1\/subscriptions\/)([^/?#:'"\\\s,)}\]]+)/gi,
  /(\/purchases\/subscriptionsv2\/tokens\/)([^/?#:'"\\\s,)}\]]+)/gi,
  /(\/purchases\/subscriptions\/[^/?#'"\\\s]+\/tokens\/)([^/?#:'"\\\s,)}\]]+)/gi,
] as const;

function normalizedCredentialKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  return (
    SENSITIVE_KEY_NAMES.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function addPropagatedSecret(secrets: Set<string>, candidate: unknown): void {
  if (typeof candidate !== "string" || candidate.length < MIN_PROPAGATED_SECRET_LENGTH) return;
  secrets.add(candidate);

  // A URL may contain an encoded copy while an exception contains the decoded
  // value (or vice versa). Retain both forms without logging either one.
  try {
    const decoded = decodeURIComponent(candidate);
    if (decoded.length >= MIN_PROPAGATED_SECRET_LENGTH) secrets.add(decoded);
  } catch {
    // A malformed percent escape is still redacted in its original form.
  }
}

function collectAllStringLeaves(
  value: unknown,
  secrets: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    addPropagatedSecret(secrets, value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectAllStringLeaves(nested, secrets, seen);
  }
}

function collectCredentialsFromString(value: string, secrets: Set<string>): void {
  for (const pattern of PROVIDER_URL_CREDENTIALS) {
    for (const match of value.matchAll(pattern)) addPropagatedSecret(secrets, match[2]);
  }
  for (const pattern of [
    DOUBLE_QUOTED_INLINE_CREDENTIAL,
    SINGLE_QUOTED_INLINE_CREDENTIAL,
    UNQUOTED_INLINE_CREDENTIAL,
    URL_QUERY_CREDENTIAL,
  ]) {
    for (const match of value.matchAll(pattern)) addPropagatedSecret(secrets, match[2]);
  }
  for (const match of value.matchAll(/\bBearer\s+([^\s,"'}]+)/gi)) {
    addPropagatedSecret(secrets, match[1]);
  }
}

function collectSentryCredentials(
  value: unknown,
  secrets: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    collectCredentialsFromString(value, secrets);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && isSensitiveKey(value[0])) {
      collectAllStringLeaves(value[1], secrets, new WeakSet());
    }
    for (const nested of value) collectSentryCredentials(nested, secrets, seen);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) collectAllStringLeaves(nested, secrets, new WeakSet());
    collectSentryCredentials(nested, secrets, seen);
  }
}

function redactCredentialString(value: string, secrets: Set<string>): string {
  let scrubbed = value;

  // Longest-first prevents a short credential that is a prefix of another
  // from leaving a credential suffix behind.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(secret).join(SENTRY_REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) scrubbed = scrubbed.split(encoded).join(SENTRY_REDACTED);
  }

  for (const pattern of PROVIDER_URL_CREDENTIALS) {
    scrubbed = scrubbed.replace(pattern, `$1${SENTRY_REDACTED}`);
  }
  scrubbed = scrubbed
    .replace(URL_QUERY_CREDENTIAL, `$1${SENTRY_REDACTED}`)
    .replace(DOUBLE_QUOTED_INLINE_CREDENTIAL, `$1"${SENTRY_REDACTED}"`)
    .replace(SINGLE_QUOTED_INLINE_CREDENTIAL, `$1'${SENTRY_REDACTED}'`)
    .replace(UNQUOTED_INLINE_CREDENTIAL, `$1${SENTRY_REDACTED}`)
    .replace(/(\bBearer\s+)[^\s,"'}]+/gi, `$1${SENTRY_REDACTED}`)
    .replace(
      /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g,
      SENTRY_REDACTED,
    );
  return scrubbed;
}

function scrubSentryValue(
  value: unknown,
  secrets: Set<string>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactCredentialString(value, secrets);
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && isSensitiveKey(value[0]) && value.length > 1) {
      value[1] = SENTRY_REDACTED;
    }
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubSentryValue(value[index], secrets, seen);
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    record[key] = isSensitiveKey(key)
      ? SENTRY_REDACTED
      : scrubSentryValue(nested, secrets, seen);
  }
  return value;
}

function scrubSentryPayload<T>(payload: T): T {
  const secrets = new Set<string>();
  collectSentryCredentials(payload, secrets, new WeakSet());
  return scrubSentryValue(payload, secrets, new WeakSet()) as T;
}

const CREDENTIAL_BEARING_IAP_ROUTE =
  /\/(?:api\/v1\/)?billing\/iap\/(?:verify|manual-reviews\/[^/?#\s]+\/decide)(?:[/?#\s]|$)/i;

function isCredentialBearingIapTrace(samplingContext: {
  name?: unknown;
  normalizedRequest?: { url?: unknown };
  attributes?: Record<string, unknown>;
}): boolean {
  const attributes = samplingContext.attributes;
  const candidates = [
    samplingContext.name,
    samplingContext.normalizedRequest?.url,
    attributes?.["http.route"],
    attributes?.["http.target"],
    attributes?.["http.url"],
    attributes?.["url.path"],
    attributes?.["url.full"],
  ];
  return candidates.some(
    (candidate) => typeof candidate === "string" && CREDENTIAL_BEARING_IAP_ROUTE.test(candidate),
  );
}

/**
 * Client-caused errors (4xx) are not server bugs — a caller sending malformed
 * JSON, a failed Zod validation, an oversized body, or a CORS rejection should
 * return a 4xx, not page ops. Capturing them floods Sentry with noise (e.g.
 * `SyntaxError: ... is not valid JSON` from bad request bodies). Mirror the
 * classification in middleware/error.ts so only genuine 5xx reach Sentry.
 */
function isClientError(err: unknown): boolean {
  if (err instanceof AppError) return err.statusCode >= 400 && err.statusCode < 500;
  if (err instanceof ZodError) return true; // → 400 validation error
  if (err instanceof SyntaxError) return true; // malformed JSON request body → 400
  const e = (err ?? {}) as { type?: string; statusCode?: number; message?: string };
  if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) return true;
  if (
    e.type === "entity.parse.failed" ||
    e.type === "entity.too.large" ||
    e.type === "charset.unsupported"
  ) {
    return true;
  }
  if (typeof e.message === "string" && e.message.includes("CORS")) return true;
  return false;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Silent no-op — keeps local dev frictionless. Production deploys MUST
    // set SENTRY_DSN; the launch checklist (README) flags this.
    return;
  }
  if (initialized) return;

  const traceSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05");

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE ?? process.env.npm_package_version ?? "0.0.0",
    // Sample 100% of errors. Sample traces sparingly (5%) — they're cheap
    // per event but add up under load. Credential-bearing IAP POST routes are
    // never traced because sampling happens before the final scrub hooks.
    tracesSampler(samplingContext) {
      if (isCredentialBearingIapTrace(samplingContext)) return 0;
      return samplingContext.inheritOrSampleWith(traceSampleRate);
    },
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSentryPayload(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryPayload(breadcrumb);
    },
    beforeSendTransaction(event) {
      return scrubSentryPayload(event);
    },
    beforeSendSpan(span) {
      return scrubSentryPayload(span);
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
  if (initialized && !isClientError(err)) {
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
