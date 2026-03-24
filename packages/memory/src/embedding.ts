/**
 * Embedding Generator — Faz 2
 *
 * Generates vector embeddings for memory items using Claude/Voyage.
 * Embeddings are stored in memory_embeddings table (pgvector).
 */

export async function generateEmbedding(_text: string): Promise<number[]> {
  // TODO: Faz 2 — Use Voyage or Claude embedding API
  throw new Error("Not implemented — Faz 2");
}

export async function storeEmbedding(
  _memoryItemId: string,
  _embedding: number[],
): Promise<void> {
  // TODO: Faz 2
  throw new Error("Not implemented — Faz 2");
}
