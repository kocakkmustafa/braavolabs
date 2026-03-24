import type { CreateMemoryInput } from "@ai-company-os/core";
import { prisma } from "./db";
import { embedMemoryItem } from "./embedding";
import { logger } from "./logger";

/**
 * Semantic Memory — stores general knowledge and learned patterns.
 * "What do we know about audience X?" / "What content style works best?"
 */

export async function storeSemanticMemory(input: CreateMemoryInput): Promise<string> {
  const item = await prisma.memoryItem.create({
    data: {
      companyId: input.companyId,
      type: "SEMANTIC",
      status: "CANDIDATE",
      content: input.content,
      metadata: (input.metadata ?? {}) as any,
      source: input.source,
      confidence: input.confidence ?? 0.5,
    },
  });

  embedMemoryItem(item.id).catch((err) =>
    logger.error({ memoryId: item.id, error: err.message }, "Failed to embed semantic memory"),
  );

  logger.info({ memoryId: item.id, companyId: input.companyId }, "Semantic memory stored");
  return item.id;
}

export async function recallSemanticMemory(
  companyId: string,
  query: string,
  limit = 5,
): Promise<Array<{ id: string; content: string; confidence: number; status: string }>> {
  const items = await prisma.memoryItem.findMany({
    where: {
      companyId,
      type: "SEMANTIC",
      status: { in: ["CANDIDATE", "APPROVED"] },
      content: { contains: query, mode: "insensitive" },
    },
    orderBy: [{ status: "desc" }, { confidence: "desc" }],
    take: limit,
  });

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
    status: i.status,
  }));
}
