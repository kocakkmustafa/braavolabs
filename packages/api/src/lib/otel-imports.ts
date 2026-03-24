/**
 * OpenTelemetry imports — centralized for clean dependency management.
 * These are optional deps; if not installed, telemetry gracefully degrades.
 */

// Re-export from @opentelemetry packages
export { NodeSDK } from "@opentelemetry/sdk-node";
export * as api from "@opentelemetry/api";
export * as resources from "@opentelemetry/resources";
export * as tracing from "@opentelemetry/sdk-trace-base";
export * as metrics from "@opentelemetry/sdk-metrics";
