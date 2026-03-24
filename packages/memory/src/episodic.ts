import type { CreateMemoryInput } from "@ai-company-os/core";
import { prisma } from "./db";
import { embedMemoryItem } from "./embedding";
import { logger } from "./logger";

/**
 * Episodic Memory — stores specific events and experiences from runs.
 * "What happened during run X?" / "How did the last campaign perform?"
 */

export async function storeEpisodicMemory(input: CreateMemoryInput): Promise<string> {
  const item = await prisma.memoryItem.create({
    data: {
      companyId: input.companyId,
      type: "EPISODIC",
      status: "CANDIDATE", // CRITICAL: always starts as CANDIDATE
      content: input.content,
      metadata: (input.metadata ?? {}) as any,
      source: input.source,
      confidence: input.confidence ?? 0.5,
    },
  });

  // Generate and store embedding asynchronously
  embedMemoryItem(item.id).catch((err) =>
    logger.error({ memoryId: item.id, error: err.message }, "Failed to embed episodic memory"),
  );

  logger.info({ memoryId: item.id, companyId: input.companyId }, "Episodic memory stored");
  return item.id;
}

export async function recallEpisodicMemory(
  companyId: string,
  query: string,
  limit = 5,
): Promise<Array<{ id: string; content: string; confidence: number; source?: string; createdAt: Date }>> {
  // Text-based recall — semantic search via searchMemory for vector-based
  const items = await prisma.memoryItem.findMany({
    where: {
      companyId,
      type: "EPISODIC",
      status: { in: ["CANDIDATE", "APPROVED"] },
      content: { contains: query, mode: "insensitive" },
    },
    orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  // Update use counts
  if (items.length > 0) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  return items.map((i) => ({
    id: i.id,
    content: i.content,
    confidence: i.confidence,
    source: i.source ?? undefined,
    createdAt: i.createdAt,
  }));
}
