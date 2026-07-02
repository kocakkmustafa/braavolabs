/**
 * OpenTelemetry Setup — Faz 7
 *
 * Configures tracing, metrics, and context propagation.
 * Must be imported BEFORE other modules (at top of entry point).
 *
 * Exports helpers for creating spans and recording metrics in business logic.
 */

import {
  NodeSDK,
  NodeTracerProvider,
  api,
  resources,
  tracing,
  metrics as metricsModule,
} from "./otel-imports";

// ─── SDK INITIALIZATION ─────────────────────────────────

let sdk: any = null;

export function initTelemetry(): void {
  // Only initialize if OTEL exporter is configured
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const resource = resources.resourceFromAttributes({
    "service.name": "ai-company-os-api",
    "service.version": process.env.npm_package_version ?? "0.1.0",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });

  if (otlpEndpoint) {
    // Production: export to OTLP collector (Jaeger, Grafana Tempo, etc.)
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");

    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
      metricReaders: [
        new metricsModule.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
          exportIntervalMillis: 30_000,
        }),
      ],
    });
    sdk.start();
  } else {
    // Development: console-only span processor for debugging
    const consoleExporter = new tracing.ConsoleSpanExporter();
    const spanProcessor = new tracing.SimpleSpanProcessor(consoleExporter);

    // SDK 2.x: addSpanProcessor/register removed from BasicTracerProvider —
    // pass spanProcessors via constructor and use NodeTracerProvider to
    // register the provider globally.
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
    });
    tracerProvider.register();
  }
}

// ─── TRACING HELPERS ────────────────────────────────────

const tracer = api.trace.getTracer("ai-company-os", "0.1.0");

/**
 * Create a span for a business operation.
 */
export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): api.Span {
  const span = tracer.startSpan(name);
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
  }
  return span;
}

/**
 * Run a function inside a traced span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: api.Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.setStatus({ code: api.SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

// ─── METRICS HELPERS ────────────────────────────────────

const meter = api.metrics.getMeter("ai-company-os", "0.1.0");

// Counters
export const runCounter = meter.createCounter("aicos.runs.total", {
  description: "Total number of pipeline runs started",
});

export const runCompletedCounter = meter.createCounter("aicos.runs.completed", {
  description: "Number of completed pipeline runs",
});

export const runFailedCounter = meter.createCounter("aicos.runs.failed", {
  description: "Number of failed pipeline runs",
});

export const toolCallCounter = meter.createCounter("aicos.tool_calls.total", {
  description: "Total number of tool calls executed",
});

export const governanceStopCounter = meter.createCounter("aicos.governance.stops", {
  description: "Number of governance stops triggered",
});

// Histograms
export const runDurationHistogram = meter.createHistogram("aicos.runs.duration_ms", {
  description: "Pipeline run duration in milliseconds",
  unit: "ms",
});

export const runCostHistogram = meter.createHistogram("aicos.runs.cost_usd", {
  description: "Pipeline run cost in USD",
  unit: "usd",
});

export const stepDurationHistogram = meter.createHistogram("aicos.steps.duration_ms", {
  description: "Step execution duration in milliseconds",
  unit: "ms",
});

// Gauges (via observable)
export const activeRunsGauge = meter.createObservableGauge("aicos.runs.active", {
  description: "Number of currently running pipelines",
});

/**
 * Shutdown telemetry gracefully.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}
