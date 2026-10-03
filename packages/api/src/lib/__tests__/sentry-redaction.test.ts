import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  withScope: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/node", () => sentryMocks);

const RAW_RECEIPT = "apple-receipt-secret-sentinel";
const RAW_TOKEN = "google-purchase-token-secret-sentinel";
const RAW_ORIGINAL_TRANSACTION_ID = "apple-original-transaction-secret-sentinel";
const RAW_SERVICE_ACCOUNT = "service-account-private-key-secret-sentinel";
const REDACTED = "[REDACTED]";

let sentryOptions: Record<string, any>;
let priorDsn: string | undefined;
let priorTraceSampleRate: string | undefined;

beforeAll(async () => {
  priorDsn = process.env.SENTRY_DSN;
  priorTraceSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;
  process.env.SENTRY_DSN = "https://public@example.invalid/1";
  process.env.SENTRY_TRACES_SAMPLE_RATE = "0.25";

  const { initSentry } = await import("../sentry");
  initSentry();
  sentryOptions = sentryMocks.init.mock.calls[0]![0];
});

afterAll(() => {
  if (priorDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = priorDsn;

  if (priorTraceSampleRate === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  else process.env.SENTRY_TRACES_SAMPLE_RATE = priorTraceSampleRate;
});

function expectNoRawCredentials(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(RAW_RECEIPT);
  expect(serialized).not.toContain(RAW_TOKEN);
  expect(serialized).not.toContain(RAW_ORIGINAL_TRANSACTION_ID);
  expect(serialized).not.toContain(RAW_SERVICE_ACCOUNT);
}

describe("Sentry credential boundary", () => {
  it("scrubs request data/body/query/URLs and exception values before sending an error", () => {
    const event = {
      type: undefined,
      request: {
        url: `https://api.example.test/api/v1/billing/iap/verify?receipt=${RAW_RECEIPT}&originalTransactionId=${RAW_ORIGINAL_TRANSACTION_ID}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${RAW_TOKEN}`,
          "x-request-id": "request-safe",
        },
        data: {
          receipt: RAW_RECEIPT,
          nested: { purchaseToken: RAW_TOKEN },
        },
        body: JSON.stringify({
          receipt: RAW_RECEIPT,
          private_key: RAW_SERVICE_ACCOUNT,
        }),
        query: {
          originalTransactionId: RAW_ORIGINAL_TRANSACTION_ID,
          safe: "query-safe",
        },
        query_string: [
          ["purchaseToken", RAW_TOKEN],
          ["safe", "query-pair-safe"],
        ],
      },
      exception: {
        values: [{
          type: "Error",
          value: `provider failed ${RAW_RECEIPT} ${RAW_TOKEN} ${RAW_ORIGINAL_TRANSACTION_ID} private_key=${RAW_SERVICE_ACCOUNT}`,
        }],
      },
      extra: {
        providerUrl: `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${RAW_ORIGINAL_TRANSACTION_ID}`,
      },
    };

    const scrubbed = sentryOptions.beforeSend(event, {});

    expectNoRawCredentials(scrubbed);
    expect(scrubbed.request.headers.authorization).toBe(REDACTED);
    expect(scrubbed.request.headers["x-request-id"]).toBe("request-safe");
    expect(scrubbed.request.query.safe).toBe("query-safe");
    expect(scrubbed.request.query_string[1]).toEqual(["safe", "query-pair-safe"]);
    expect(JSON.stringify(scrubbed)).toContain(REDACTED);
  });

  it("scrubs Apple and Google outbound breadcrumb URLs and credential-bearing data", () => {
    const breadcrumb = {
      type: "http",
      category: "fetch",
      message: `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.braavolabs.mobile/purchases/subscriptionsv2/tokens/${RAW_TOKEN}`,
      data: {
        method: "GET",
        url: `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${RAW_ORIGINAL_TRANSACTION_ID}`,
        requestBody: JSON.stringify({ receipt: RAW_RECEIPT }),
        serviceAccount: { private_key: RAW_SERVICE_ACCOUNT },
      },
    };

    const scrubbed = sentryOptions.beforeBreadcrumb(breadcrumb, {});

    expectNoRawCredentials(scrubbed);
    expect(scrubbed.data.method).toBe("GET");
    expect(scrubbed.category).toBe("fetch");
    expect(JSON.stringify(scrubbed)).toContain(REDACTED);
  });

  it("scrubs credential-bearing transaction and span payloads", () => {
    const transaction = {
      type: "transaction",
      transaction: "GET /api/v1/health",
      spans: [{
        span_id: "1234567890abcdef",
        trace_id: "1234567890abcdef1234567890abcdef",
        start_timestamp: 1,
        description: `POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.braavolabs.mobile/purchases/subscriptions/com.braavolabs.individual.monthly/tokens/${RAW_TOKEN}:acknowledge`,
        data: {
          "url.full": `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${RAW_ORIGINAL_TRANSACTION_ID}`,
          "http.request.body": JSON.stringify({
            receipt: RAW_RECEIPT,
            private_key: RAW_SERVICE_ACCOUNT,
          }),
        },
      }],
    };

    const scrubbedTransaction = sentryOptions.beforeSendTransaction(transaction, {});
    const scrubbedSpan = sentryOptions.beforeSendSpan({
      span_id: "abcdef1234567890",
      trace_id: "abcdef1234567890abcdef1234567890",
      start_timestamp: 1,
      description: `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.braavolabs.mobile/purchases/subscriptionsv2/tokens/${RAW_TOKEN}`,
      data: {
        receipt: RAW_RECEIPT,
        originalTransactionId: RAW_ORIGINAL_TRANSACTION_ID,
        private_key: RAW_SERVICE_ACCOUNT,
      },
    });

    expectNoRawCredentials(scrubbedTransaction);
    expectNoRawCredentials(scrubbedSpan);
    expect(scrubbedTransaction.transaction).toBe("GET /api/v1/health");
    expect(JSON.stringify(scrubbedTransaction)).toContain(REDACTED);
    expect(JSON.stringify(scrubbedSpan)).toContain(REDACTED);
  });

  it("scrubs receipt-data aliases and serialized passwords without damaging benign prose", () => {
    const receiptDataKebab = "receipt-data-secret-sentinel";
    const receiptDataSnake = "receipt_data_secret_sentinel";
    const receiptDataCamel = "receiptDataSecretSentinel";
    const password = "database-password-secret-sentinel";
    const benign = "Password rotation completed; receipt data was verified by the provider.";
    const event = {
      request: {
        data: {
          "receipt-data": receiptDataKebab,
          receipt_data: receiptDataSnake,
          receiptData: receiptDataCamel,
        },
        body: JSON.stringify({
          receipt_data: receiptDataSnake,
          receiptData: receiptDataCamel,
          password,
        }),
      },
      exception: {
        values: [{
          value: `provider body={"receipt-data":"${receiptDataKebab}","password":"${password}"}`,
        }],
      },
      extra: { benign },
    };

    const scrubbed = sentryOptions.beforeSend(event, {});
    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain(receiptDataKebab);
    expect(serialized).not.toContain(receiptDataSnake);
    expect(serialized).not.toContain(receiptDataCamel);
    expect(serialized).not.toContain(password);
    expect(scrubbed.request.data).toEqual({
      "receipt-data": REDACTED,
      receipt_data: REDACTED,
      receiptData: REDACTED,
    });
    expect(scrubbed.extra.benign).toBe(benign);
  });

  it.each(["beforeSend", "beforeBreadcrumb", "beforeSendTransaction", "beforeSendSpan"])(
    "%s handles getter-only and frozen payloads without retaining credentials", (hook) => {
      const extra = Object.freeze({ purchaseToken: RAW_TOKEN,
        nested: Object.freeze([Object.freeze({ receipt: RAW_RECEIPT }),
          Object.freeze(["private_key", RAW_SERVICE_ACCOUNT])]) });
      const getter = vi.fn(() => "safe SDK metadata");
      const payload = Object.freeze(Object.defineProperty({ extra, message: RAW_TOKEN }, "$", {
        enumerable: true, get: getter,
      }));
      const scrubbed = sentryOptions[hook](payload, {});
      expectNoRawCredentials(scrubbed);
      expect(getter).not.toHaveBeenCalled();
      if (hook === "beforeSendSpan") {
        expect(scrubbed.data).toEqual({ "sentry.redaction_reason": "unreadable-payload" });
        expect(scrubbed.span_id).toMatch(/^[a-f0-9]{16}$/);
        expect(scrubbed.trace_id).toMatch(/^[a-f0-9]{32}$/);
      } else expect(scrubbed).toBeNull();
      expect(extra.purchaseToken).toBe(RAW_TOKEN);
    },
  );

  it.each(["getter-only", "nonwritable", "frozen-array"])("handles isolated %s redaction", (kind) => {
    const payload = kind === "frozen-array"
      ? { extra: Object.freeze([Object.freeze(["purchaseToken", RAW_TOKEN])]) }
      : Object.defineProperty({ receipt: RAW_RECEIPT }, "$", kind === "getter-only"
        ? { enumerable: true, get: () => "sdk metadata" }
        : { enumerable: true, value: "sdk metadata", writable: false });
    expectNoRawCredentials(sentryOptions.beforeSend(payload, {}));
  });

  it("preserves ordinary dates and collects their own credential properties", () => {
    const date = Object.assign(new Date(0), { receipt: RAW_RECEIPT });
    const scrubbed = sentryOptions.beforeSend({ extra: { date, ordinary: new Date(0) }, message: RAW_RECEIPT }, {});
    expectNoRawCredentials(scrubbed);
    expect(scrubbed.message).toBe(REDACTED);
    expect(scrubbed.extra.date.receipt).toBe(REDACTED);
    expect(scrubbed.extra.ordinary.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("does not invoke custom date accessors and suppresses their payload", () => {
    const getTime = vi.fn(() => { throw new Error(RAW_TOKEN); });
    const date = Object.defineProperty(new Date(0), "getTime", { enumerable: true, get: getTime });
    expect(sentryOptions.beforeSend({ extra: { date }, message: RAW_TOKEN }, {})).toBeNull();
    expect(getTime).not.toHaveBeenCalled();
  });

  it("sanitizes shared and cyclic references and own prototype-shaped keys", () => {
    const shared: any = { receipt: RAW_RECEIPT };
    shared.self = shared;
    const extra = Object.defineProperty({ first: shared, second: shared }, "__proto__", {
      enumerable: true, value: { purchaseToken: RAW_TOKEN }, writable: false,
    });
    const scrubbed = sentryOptions.beforeSend({ extra, message: RAW_RECEIPT }, {});
    expect(scrubbed.extra.first).toBe(scrubbed.extra.second);
    expect(scrubbed.extra.first.self).toBe(scrubbed.extra.first);
    expect(scrubbed.extra.first.receipt).toBe(REDACTED);
    expect(scrubbed.extra.__proto__.purchaseToken).toBe(REDACTED);
    expect(scrubbed.message).toBe(REDACTED);
    expect(shared.receipt).toBe(RAW_RECEIPT);
    expect(Object.getPrototypeOf(scrubbed.extra)).toBe(Object.prototype);
  });

  it("redacts nonwritable fields and throwing getters without leaking their exceptions", () => {
    const getter = vi.fn(() => { throw new Error(RAW_SERVICE_ACCOUNT); });
    const extra = Object.defineProperties({}, {
      receipt: { enumerable: true, value: RAW_RECEIPT, writable: false },
      bad: { enumerable: true, get: getter },
    });
    const scrubbed = sentryOptions.beforeSend({ extra, message: RAW_RECEIPT }, {});
    expectNoRawCredentials(scrubbed);
    expect(scrubbed).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["beforeSend", "beforeBreadcrumb", "beforeSendTransaction", "beforeSendSpan"])(
    "%s fails closed for an unreadable credential copied into free text", (hook) => {
      const secret = "unformatted-accessor-only-sentinel";
      const getter = vi.fn(() => secret);
      const setter = vi.fn();
      const extra = Object.defineProperty({}, "receipt", { enumerable: true, get: getter, set: setter });
      const payload = { extra, message: `provider failed ${secret}`,
        exception: { values: [{ value: `opaque failure ${secret}` }] },
        description: `request failed ${secret}`, data: { copied: secret }, safe: "diagnostic text" };
      const scrubbed = sentryOptions[hook](payload, {});
      expect(JSON.stringify(scrubbed)).not.toContain(secret);
      if (hook === "beforeSendSpan") {
        expect(scrubbed.description).toBe(REDACTED);
        expect(scrubbed.data).toEqual({ "sentry.redaction_reason": "unreadable-payload" });
      } else expect(scrubbed).toBeNull();
      expect(getter).not.toHaveBeenCalled();
      expect(setter).not.toHaveBeenCalled();
      expect(payload.message).toBe(`provider failed ${secret}`);
    },
  );

  it.each(["hidden-container", "throwing-getter", "unreadable-object"])(
    "fails closed for propagation through %s", (kind) => {
      const secret = "different-unformatted-hidden-secret";
      const getter = vi.fn(() => {
        if (kind === "throwing-getter") throw new Error(secret);
        return { receipt: secret };
      });
      const extra = kind === "unreadable-object"
        ? new Proxy({}, { ownKeys: () => { throw new Error(secret); } })
        : Object.defineProperty({}, "container", { enumerable: true, get: getter });
      const scrubbed = sentryOptions.beforeSend({ extra, message: `failure ${secret}` }, {});
      expect(JSON.stringify(scrubbed)).not.toContain(secret);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(["beforeSend", "beforeBreadcrumb", "beforeSendTransaction", "beforeSendSpan"])(
    "%s exposes no original fields or secret-shaped keys for an unreadable root", (hook) => {
      const secret = "secret-shaped-key-sentinel";
      const target = Object.defineProperty({ [secret]: secret }, "receipt", {
        enumerable: true, get: () => { throw new Error(secret); },
      });
      const { proxy, revoke } = Proxy.revocable(target, {});
      revoke();
      const result = sentryOptions[hook](proxy, {});
      expect(JSON.stringify(result)).not.toContain(secret);
      if (hook === "beforeSendSpan") expect(result).toEqual({
        span_id: "0000000000000001", trace_id: "00000000000000000000000000000001",
        start_timestamp: 0, timestamp: 0, description: REDACTED,
        data: { "sentry.redaction_reason": "unreadable-payload" },
      });
      else expect(result).toBeNull();
    },
  );

  it("provides a payload-free suppression counter", async () => {
    const { getSentryRedactionStats } = await import("../sentry");
    const before = getSentryRedactionStats().unreadablePayloadCount;
    sentryOptions.beforeSend(Object.defineProperty({}, "receipt", {
      enumerable: true, get: () => RAW_RECEIPT,
    }), {});
    expect(getSentryRedactionStats()).toEqual({ unreadablePayloadCount: before + 1 });
  });

  it("drops credential-bearing IAP request transactions while preserving normal trace sampling", () => {
    const inheritOrSampleWith = vi.fn((fallback: number) => fallback);

    expect(sentryOptions.tracesSampler({
      name: "POST /api/v1/billing/iap/verify",
      attributes: { "http.route": "/api/v1/billing/iap/verify" },
      inheritOrSampleWith,
    })).toBe(0);
    expect(sentryOptions.tracesSampler({
      name: "POST /api/v1/billing/iap/manual-reviews/case-123/decide",
      normalizedRequest: {
        url: "https://api.example.test/api/v1/billing/iap/manual-reviews/case-123/decide",
      },
      inheritOrSampleWith,
    })).toBe(0);
    expect(sentryOptions.tracesSampler({
      name: "GET /api/v1/health",
      attributes: { "http.route": "/api/v1/health" },
      inheritOrSampleWith,
    })).toBe(0.25);
    expect(inheritOrSampleWith).toHaveBeenCalledWith(0.25);
  });
});

// Execute the installed SDK's actual private pipeline with local hooks and a
// dropped-event stub; no client, transport, instrumentation or event send.
function runInstalledSdkBeforeSend(event: Record<string, any>): any {
  const require = createRequire(import.meta.url);
  const nodeEntry = require.resolve("@sentry/node");
  const coreEntry = createRequire(nodeEntry).resolve("@sentry/core");
  const clientPath = join(dirname(coreEntry), "client.js");
  const source = readFileSync(clientPath, "utf8");
  const start = source.indexOf("function processBeforeSend(");
  const end = source.indexOf("function isErrorEvent(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const sdkRequire = createRequire(clientPath);
  const pipeline = runInNewContext(
    source.slice(start, end) +
      '\nfunction isErrorEvent(event) { return event.type === undefined; }' +
      '\nfunction isTransactionEvent(event) { return event.type === "transaction"; }' +
      '\nprocessBeforeSend;',
    {
      beforeSendSpan: sdkRequire("./tracing/spans/beforeSendSpan.js"),
      transactionEvent: sdkRequire("./utils/transactionEvent.js"),
      merge: sdkRequire("./utils/merge.js"),
      shouldIgnoreSpan: sdkRequire("./utils/should-ignore-span.js"),
      spanUtils: sdkRequire("./utils/spanUtils.js"),
    },
  );
  return pipeline({ recordDroppedEvent: vi.fn() }, sentryOptions, event, {});
}

describe("installed SDK composed Sentry boundary", () => {
  it.each(["child", "root"])("suppresses copied accessor credentials after %s span processing", (kind) => {
    const getter = vi.fn(() => RAW_TOKEN);
    const data = {};
    Object.defineProperty(data, "purchaseToken", { enumerable: true, get: getter });
    const span = {
      span_id: "1234567890abcdef", trace_id: "1234567890abcdef1234567890abcdef",
      start_timestamp: 1, timestamp: 2, description: "safe span", data,
    };
    const event = {
      type: "transaction", transaction: "safe transaction", start_timestamp: 1, timestamp: 2,
      contexts: { trace: {
        span_id: "abcdef1234567890", trace_id: span.trace_id,
        data: kind === "root" ? data : { safe: "root metadata" },
      } },
      spans: kind === "child" ? [span] : [],
      extra: { message: `copied credential ${RAW_TOKEN}` },
    };
    const result = runInstalledSdkBeforeSend(event);
    expect(getter).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("preserves readable transaction metadata and normal credential redaction", () => {
    const result = runInstalledSdkBeforeSend({
      type: "transaction", transaction: "safe transaction", start_timestamp: 1, timestamp: 2,
      contexts: { trace: { span_id: "abcdef1234567890", trace_id: "1234567890abcdef1234567890abcdef", data: { safe: "root metadata" } } },
      spans: [{ span_id: "1234567890abcdef", trace_id: "1234567890abcdef1234567890abcdef", start_timestamp: 1, timestamp: 2,
        description: "safe span", data: { purchaseToken: RAW_TOKEN, safe: "child metadata" } }],
      extra: { safe: "event metadata" },
    });
    expectNoRawCredentials(result);
    expect(result.extra.safe).toBe("event metadata");
    expect(result.contexts.trace.data.safe).toBe("root metadata");
    expect(result.spans[0].data.safe).toBe("child metadata");
    expect(result.spans[0].data.purchaseToken).toBe(REDACTED);
  });
});
