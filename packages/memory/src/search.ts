import type { MemorySearchInput, MemorySearchResult } from "@ai-company-os/core";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { generateEmbedding } from "./embedding";
import { logger } from "./logger";

// Whitelists to prevent injection via enum-like fields
const ALLOWED_TYPES = new Set(["EPISODIC", "SEMANTIC", "PROCEDURAL"]);
const ALLOWED_STATUSES = new Set(["CANDIDATE", "APPROVED", "DEPRECATED"]);

/**
 * Semantic memory search using pgvector cosine similarity.
 *
 * Security: All user-supplied values are bound as parameters via Prisma.sql
 * tagged template. Enum-like inputs (type, status) are validated against
 * whitelists to ensure ::vector/::text casts never receive attacker strings.
 *
 * 1. Generate embedding for query text
 * 2. Validate & bind filters (tenant-isolated via companyId)
 * 3. Run cosine similarity search via parameterized raw SQL
 * 4. Return ranked results with similarity scores
 */
export async function searchMemory(
  input: MemorySearchInput,
): Promise<MemorySearchResult[]> {
  const { companyId, query, type, status, limit = 10, minConfidence = 0 } = input;

  if (!companyId || typeof companyId !== "string") {
    throw new Error("searchMemory: companyId is required");
  }
  if (type && !ALLOWED_TYPES.has(type)) {
    throw new Error(`searchMemory: invalid type "${type}"`);
  }
  if (status && !ALLOWED_STATUSES.has(status)) {
    throw new Error(`searchMemory: invalid status "${status}"`);
  }
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const safeConfidence = Math.max(0, Math.min(1, minConfidence));

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Build parameterized filter conditions (no string interpolation)
  const conditions: Prisma.Sql[] = [Prisma.sql`mi.company_id = ${companyId}`];
  if (type) conditions.push(Prisma.sql`mi.type::text = ${type}`);
  if (status) conditions.push(Prisma.sql`mi.status::text = ${status}`);
  if (safeConfidence > 0) conditions.push(Prisma.sql`mi.confidence >= ${safeConfidence}`);

  const whereClause = Prisma.join(conditions, " AND ");

  // pgvector cosine similarity search — fully parameterized
  // 1 - (embedding <=> query) gives cosine similarity (0 to 1)
  const results = await prisma.$queryRaw<
    Array<{
      id: string;
      content: string;
      type: string;
      status: string;
      confidence: number;
      metadata: any;
      similarity: number;
    }>
  >`
    SELECT
      mi.id,
      mi.content,
      mi.type,
      mi.status,
      mi.confidence,
      mi.metadata,
      1 - (me.embedding <=> ${vecStr}::vector) AS similarity
    FROM memory_items mi
    JOIN memory_embeddings me ON me.memory_item_id = mi.id
    WHERE ${whereClause}
    ORDER BY me.embedding <=> ${vecStr}::vector
    LIMIT ${safeLimit}
  `;

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
