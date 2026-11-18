import { FAKE_LLM_ORIGIN } from "../ports";
import type { RecordedRequest } from "./fake-llm";

export type { RecordedRequest };

/** Forget every recorded request (call at the start of a spec; workers=1 so no race). */
export async function resetFakeLlm(): Promise<void> {
  const res = await fetch(`${FAKE_LLM_ORIGIN}/__reset`, { method: "POST" });
  if (!res.ok) throw new Error(`fake-llm reset failed: ${res.status}`);
}

/** Every request the fake model received since the last reset. */
export async function fakeLlmRequests(): Promise<RecordedRequest[]> {
  const res = await fetch(`${FAKE_LLM_ORIGIN}/__requests`);
  if (!res.ok) throw new Error(`fake-llm requests failed: ${res.status}`);
  return (await res.json()) as RecordedRequest[];
}
