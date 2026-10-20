"use client";

import { useTranslations } from "next-intl";

export type FailureKind = "session" | "forbidden" | "network" | "rateLimit" | "timeout" | "generic";

/** Only locally translated control-flow messages may opt in to direct display. */
export class LocalizedUiError extends Error {}

/** Classify the envelope, never return an opaque provider/server message to UI. */
export function classifyFailure(error: unknown): FailureKind {
  if (!error || typeof error !== "object") return "generic";
  const record = error as { status?: unknown; name?: unknown; code?: unknown; message?: unknown };
  if (record.status === 401 || record.name === "SessionChangedError") return "session";
  if (record.status === 403) return "forbidden";
  if (record.status === 429) return "rateLimit";
  if (record.status === 408 || record.status === 504 || record.name === "TimeoutError" || record.code === "REQUEST_TIMEOUT") return "timeout";
  // Fetch has no HTTP response envelope. Match only its known failure phrases.
  const message = typeof record.message === "string" ? record.message : "";
  if (record.name === "TypeError" && /failed to fetch|fetch failed|networkerror|load failed/i.test(message)) return "network";
  return "generic";
}

export function useLocalizedFailure() {
  const copy = useTranslations("surface.error");
  return (error: unknown, fallback?: string): string => {
    if (error instanceof LocalizedUiError) return error.message;
    const kind = classifyFailure(error);
    return kind === "generic" ? (fallback ?? copy("generic")) : copy(kind);
  };
}
