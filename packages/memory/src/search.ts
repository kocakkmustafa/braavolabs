/**
 * Memory Search — Faz 2
 *
 * pgvector similarity search across memory items.
 */

import type { MemorySearchInput, MemorySearchResult } from "@ai-company-os/core";

export async function searchMemory(
  _input: MemorySearchInput,
): Promise<MemorySearchResult[]> {
  // TODO: Faz 2
  // 1. Generate embedding for query
  // 2. pgvector cosine similarity search
  // 3. Filter by type, status, confidence
  // 4. Return ranked results
  throw new Error("Not implemented — Faz 2");
}
