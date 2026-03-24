/**
 * Procedural Memory — Faz 2
 *
 * Stores learned procedures and skills.
 * "How do we best create LinkedIn posts for B2B?"
 */

import type { CreateMemoryInput } from "@ai-company-os/core";

export async function storeProceduralMemory(_input: CreateMemoryInput): Promise<string> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}

export async function recallProceduralMemory(
  _companyId: string,
  _query: string,
  _limit?: number,
): Promise<unknown[]> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}
