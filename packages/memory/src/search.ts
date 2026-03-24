import type { MemorySearchInput, MemorySearchResult } from "@ai-company-os/core";
import { prisma } from "./db";
import { generateEmbedding } from "./embedding";
import { logger } from "./logger";

/**
 * Semantic memory search using pgvector cosine similarity.
 *
 * 1. Generate embedding for query text
 * 2. Run cosine similarity search via raw SQL
 * 3. Filter by type, status, confidence
 * 4. Return ranked results with similarity scores
 */
export async function searchMemory(
  input: MemorySearchInput,
): Promise<MemorySearchResult[]> {
  const { companyId, query, type, status, limit = 10, minConfidence = 0 } = input;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Build filter conditions
  const conditions: string[] = [`mi.company_id = '${companyId}'`];
  if (type) conditions.push(`mi.type = '${type}'`);
  if (status) conditions.push(`mi.status = '${status}'`);
  if (minConfidence > 0) conditions.push(`mi.confidence >= ${minConfidence}`);

  const whereClause = conditions.join(" AND ");

  // pgvector cosine similarity search
  // 1 - (embedding <=> query) gives cosine similarity (0 to 1)
  const results = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      content: string;
      type: string;
      status: string;
      confidence: number;
      metadata: any;
      similarity: number;
    }>
  >(
    `SELECT
       mi.id,
       mi.content,
       mi.type,
       mi.status,
       mi.confidence,
       mi.metadata,
       1 - (me.embedding <=> $1::vector) AS similarity
     FROM memory_items mi
     JOIN memory_embeddings me ON me.memory_item_id = mi.id
     WHERE ${whereClause}
     ORDER BY me.embedding <=> $1::vector
     LIMIT $2`,
    vecStr,
    limit,
  );

  logger.debug(
    { companyId, query: query.slice(0, 50), results: results.length },
    "Memory search completed",
  );

  return results.map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type as MemorySearchResult["type"],
    status: r.status as MemorySearchResult["status"],
    confidence: r.confidence,
    similarity: r.similarity,
    metadata: r.metadata ?? {},
  }));
}

/**
 * Text-based fallback search (when embeddings are not available).
 */
export async function searchMemoryText(
  input: MemorySearchInput,
): Promise<MemorySearchResult[]> {
  const { companyId, query, type, status, limit = 10 } = input;

  const memories = await prisma.memoryItem.findMany({
    where: {
      companyId,
      ...(type && { type }),
      ...(status && { status }),
      content: { contains: query, mode: "insensitive" },
    },
    orderBy: [{ status: "desc" }, { confidence: "desc" }, { useCount: "desc" }],
    take: limit,
  });

  return memories.map((m) => ({
    id: m.id,
    content: m.content,
    type: m.type as MemorySearchResult["type"],
    status: m.status as MemorySearchResult["status"],
    confidence: m.confidence,
    similarity: 0, // not available for text search
    metadata: (m.metadata as Record<string, unknown>) ?? {},
  }));
}
