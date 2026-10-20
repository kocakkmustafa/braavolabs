"use client";

import { useTranslations } from "next-intl";

const STATES = new Set(["running", "completed", "paused", "failed", "cancelled", "waiting_approval", "pending", "active", "disabled", "draft", "queued"]);

/** Labels never replace the original enum used by API requests or CSS logic. */
export function useStateLabel() {
  const copy = useTranslations("surface.states");
  return (value: unknown): string => {
    const state = typeof value === "string" ? value.toLowerCase() : "";
    return copy(STATES.has(state) ? state : "unknown");
  };
}
