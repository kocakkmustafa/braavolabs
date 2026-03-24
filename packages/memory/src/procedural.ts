import type { CreateMemoryInput } from "@ai-company-os/core";
import { prisma } from "./db";
import { embedMemoryItem } from "./embedding";
import { logger } from "./logger";

/**
 * Procedural Memory — stores learned procedures and skills.
 * "How do we best create LinkedIn posts for B2B?"
 * "What's the best outreach sequence for SaaS leads?"
 */

export async function storeProceduralMemory(input: CreateMemoryInput): Promise<string> {
  const item = await prisma.memoryItem.create({
    data: {
      companyId: input.companyId,
      type: "PROCEDURAL",
      status: "CANDIDATE",
      content: input.content,
      metadata: (input.metadata ?? {}) as any,
      source: input.source,
      confidence: input.confidence ?? 0.5,
    },
  });

  embedMemoryItem(item.id).catch((err) =>
    logger.error({ memoryId: item.id, error: err.message }, "Failed to embed procedural memory"),
  );

  logger.info({ memoryId: item.id, companyId: input.companyId }, "Procedural memory stored");
  return item.id;
}

export async function recallProceduralMemory(
  companyId: string,
  query: string,
  limit = 5,
): Promise<Array<{ id: string; content: string; confidence: number; status: string }>> {
  // Procedural memories: prioritize APPROVED over CANDIDATE
  const items = await prisma.memoryItem.findMany({
    where: {
      companyId,
      type: "PROCEDURAL",
      status: { in: ["CANDIDATE", "APPROVED"] },
      content: { contains: query, mode: "insensitive" },
    },
    orderBy: [{ status: "desc" }, { confidence: "desc" }, { useCount: "desc" }],
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
