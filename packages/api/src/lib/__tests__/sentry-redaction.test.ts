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
