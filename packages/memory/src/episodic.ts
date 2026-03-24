/**
 * Episodic Memory — Faz 2
 *
 * Stores specific events and experiences from runs.
 * "What happened during run X?"
 */

import type { CreateMemoryInput } from "@ai-company-os/core";

export async function storeEpisodicMemory(_input: CreateMemoryInput): Promise<string> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}

export async function recallEpisodicMemory(
  _companyId: string,
  _query: string,
  _limit?: number,
): Promise<unknown[]> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}
