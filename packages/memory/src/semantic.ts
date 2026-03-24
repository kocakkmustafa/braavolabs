/**
 * Semantic Memory — Faz 2
 *
 * Stores general knowledge and patterns learned.
 * "What do we know about audience X?"
 */

import type { CreateMemoryInput } from "@ai-company-os/core";

export async function storeSemanticMemory(_input: CreateMemoryInput): Promise<string> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}

export async function recallSemanticMemory(
  _companyId: string,
  _query: string,
  _limit?: number,
): Promise<unknown[]> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}
