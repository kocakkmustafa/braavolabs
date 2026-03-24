import type { MemoryEdgeInput } from "@ai-company-os/core";
import { prisma } from "./db";
import { logger } from "./logger";

/**
 * Memory Graph — manages edges between memory items.
 * Relations: supports, contradicts, derives_from, generalizes, specializes
 */

export async function addEdge(input: MemoryEdgeInput): Promise<string> {
  const edge = await prisma.memoryEdge.upsert({
    where: {
      fromId_toId_relation: {
        fromId: input.fromId,
        toId: input.toId,
        relation: input.relation,
      },
    },
    update: { weight: input.weight ?? 1.0 },
    create: {
      fromId: input.fromId,
      toId: input.toId,
      relation: input.relation,
      weight: input.weight ?? 1.0,
    },
  });

  logger.debug(
    { edgeId: edge.id, from: input.fromId, to: input.toId, relation: input.relation },
    "Memory edge added",
  );

  return edge.id;
}

export async function removeEdge(fromId: string, toId: string, relation: string): Promise<void> {
  await prisma.memoryEdge.deleteMany({
    where: { fromId, toId, relation },
  });
}

export async function getRelatedMemories(
  memoryItemId: string,
  relation?: string,
  direction: "outgoing" | "incoming" | "both" = "both",
): Promise<
  Array<{
    id: string;
    content: string;
    type: string;
    relation: string;
    weight: number;
    direction: "outgoing" | "incoming";
  }>
> {
  const results: Array<{
    id: string;
    content: string;
    type: string;
    relation: string;
    weight: number;
    direction: "outgoing" | "incoming";
  }> = [];

  if (direction === "outgoing" || direction === "both") {
    const outgoing = await prisma.memoryEdge.findMany({
      where: {
        fromId: memoryItemId,
        ...(relation && { relation }),
      },
      include: { to: true },
    });
    for (const edge of outgoing) {
      results.push({
        id: edge.to.id,
        content: edge.to.content,
        type: edge.to.type,
        relation: edge.relation,
        weight: edge.weight,
        direction: "outgoing",
      });
    }
  }

  if (direction === "incoming" || direction === "both") {
    const incoming = await prisma.memoryEdge.findMany({
      where: {
        toId: memoryItemId,
        ...(relation && { relation }),
      },
      include: { from: true },
    });
    for (const edge of incoming) {
      results.push({
        id: edge.from.id,
        content: edge.from.content,
        type: edge.from.type,
        relation: edge.relation,
        weight: edge.weight,
        direction: "incoming",
      });
    }
  }

  return results;
}

/**
 * Find contradicting memories for a given memory item.
 */
export async function findContradictions(
  memoryItemId: string,
): Promise<Array<{ id: string; content: string }>> {
  const related = await getRelatedMemories(memoryItemId, "contradicts");
  return related.map((r) => ({ id: r.id, content: r.content }));
}

/**
 * Get the full subgraph around a memory item (BFS up to depth).
 */
export async function getSubgraph(
  memoryItemId: string,
  maxDepth = 2,
): Promise<Map<string, Array<{ targetId: string; relation: string; weight: number }>>> {
  const graph = new Map<string, Array<{ targetId: string; relation: string; weight: number }>>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: memoryItemId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const edges = await prisma.memoryEdge.findMany({
      where: { fromId: id },
    });

    const connections = edges.map((e) => ({
      targetId: e.toId,
      relation: e.relation,
      weight: e.weight,
    }));

    graph.set(id, connections);

    for (const conn of connections) {
      if (!visited.has(conn.targetId)) {
        queue.push({ id: conn.targetId, depth: depth + 1 });
      }
    }
  }

  return graph;
}
