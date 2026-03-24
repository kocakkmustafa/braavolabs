import { prisma } from "./db";
import { logger } from "./logger";
import { generateEmbedding, storeEmbedding } from "./embedding";
import { addEdge } from "./graph";

/**
 * Memory Consolidation Engine
 *
 * Daily batch job that:
 * 1. Promotes high-confidence candidates → APPROVED
 * 2. Deprecates stale/unused memories
 * 3. Detects similar memories and creates graph edges
 * 4. Checks cross-company patterns for holding brain promotion
 *
 * CRITICAL RULES:
 * - Memory lifecycle: CANDIDATE → APPROVED → DEPRECATED
 * - Never directly write APPROVED — must go through CANDIDATE first
 * - Holding brain promotion requires 2+ companies showing same pattern
 * - Single-example generalization is FORBIDDEN
 */

export interface ConsolidationResult {
  promoted: number;
  deprecated: number;
  edgesCreated: number;
  holdingBrainCandidates: number;
  embeddingsGenerated: number;
}

/**
 * Run full consolidation for a tenant.
 */
export async function runConsolidation(tenantId: string): Promise<ConsolidationResult> {
  logger.info({ tenantId }, "Starting memory consolidation");

  const result: ConsolidationResult = {
    promoted: 0,
    deprecated: 0,
    edgesCreated: 0,
    holdingBrainCandidates: 0,
    embeddingsGenerated: 0,
  };

  // Get all companies for this tenant
  const companies = await prisma.company.findMany({
    where: { tenantId },
    select: { id: true },
  });

  for (const company of companies) {
    const companyResult = await consolidateCompany(company.id);
    result.promoted += companyResult.promoted;
    result.deprecated += companyResult.deprecated;
    result.edgesCreated += companyResult.edgesCreated;
    result.embeddingsGenerated += companyResult.embeddingsGenerated;
  }

  // Cross-company holding brain check
  if (companies.length >= 2) {
    result.holdingBrainCandidates = await checkHoldingBrainPromotion(
      tenantId,
      companies.map((c) => c.id),
    );
  }

  logger.info({ tenantId, result }, "Memory consolidation complete");
  return result;
}

/**
 * Consolidate memories for a single company.
 */
async function consolidateCompany(companyId: string): Promise<{
  promoted: number;
  deprecated: number;
  edgesCreated: number;
  embeddingsGenerated: number;
}> {
  let promoted = 0;
  let deprecated = 0;
  let edgesCreated = 0;
  let embeddingsGenerated = 0;

  // ── 1. Promote high-confidence candidates ──────────────
  // Requirements: confidence >= 0.7, used >= 3 times, aged >= 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const promotable = await prisma.memoryItem.findMany({
    where: {
      companyId,
      status: "CANDIDATE",
      confidence: { gte: 0.7 },
      useCount: { gte: 3 },
      createdAt: { lte: sevenDaysAgo },
    },
  });

  if (promotable.length > 0) {
    const promoteResult = await prisma.memoryItem.updateMany({
      where: { id: { in: promotable.map((p) => p.id) } },
      data: { status: "APPROVED", promotedAt: new Date() },
    });
    promoted = promoteResult.count;
    logger.info({ companyId, promoted }, "Memories promoted to APPROVED");
  }

  // ── 2. Deprecate stale memories ────────────────────────
  // APPROVED memories not used in 90 days
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const staleResult = await prisma.memoryItem.updateMany({
    where: {
      companyId,
      status: "APPROVED",
      OR: [
        { lastUsedAt: { lt: ninetyDaysAgo } },
        { lastUsedAt: null, createdAt: { lt: ninetyDaysAgo } },
      ],
    },
    data: { status: "DEPRECATED" },
  });
  deprecated = staleResult.count;

  // Deprecate low-confidence candidates older than 30 days with 0 uses
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const abandonedResult = await prisma.memoryItem.updateMany({
    where: {
      companyId,
      status: "CANDIDATE",
      confidence: { lt: 0.4 },
      useCount: 0,
      createdAt: { lt: thirtyDaysAgo },
    },
    data: { status: "DEPRECATED" },
  });
  deprecated += abandonedResult.count;

  // ── 3. Generate missing embeddings ─────────────────────
  const withoutEmbeddings = await prisma.memoryItem.findMany({
    where: {
      companyId,
      status: { in: ["CANDIDATE", "APPROVED"] },
      embedding: null,
    },
    take: 50, // batch limit
  });

  for (const item of withoutEmbeddings) {
    try {
      const embedding = await generateEmbedding(item.content);
      await storeEmbedding(item.id, embedding);
      embeddingsGenerated++;
    } catch (err) {
      logger.error(
        { memoryId: item.id, error: (err as Error).message },
        "Failed to generate embedding during consolidation",
      );
    }
  }

  // ── 4. Detect similar memories and create edges ────────
  // Find pairs of APPROVED memories that might be related
  const approved = await prisma.memoryItem.findMany({
    where: { companyId, status: "APPROVED" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Simple content overlap detection (full vector similarity in production)
  for (let i = 0; i < approved.length; i++) {
    for (let j = i + 1; j < approved.length; j++) {
      const overlap = contentOverlap(approved[i].content, approved[j].content);
      if (overlap > 0.5) {
        // Check if they're the same type → "supports", different type → "derives_from"
        const relation =
          approved[i].type === approved[j].type ? "supports" : "derives_from";
        try {
          await addEdge({
            fromId: approved[i].id,
            toId: approved[j].id,
            relation,
            weight: overlap,
          });
          edgesCreated++;
        } catch {
          // Edge might already exist — ignore
        }
      }
    }
  }

  return { promoted, deprecated, edgesCreated, embeddingsGenerated };
}

/**
 * Check for cross-company patterns eligible for holding brain promotion.
 *
 * CRITICAL: Requires 2+ DIFFERENT companies showing the same pattern.
 * Single-example generalization is FORBIDDEN.
 */
async function checkHoldingBrainPromotion(
  tenantId: string,
  companyIds: string[],
): Promise<number> {
  let candidates = 0;

  // Get approved procedural memories from all companies
  const proceduralMemories = await prisma.memoryItem.findMany({
    where: {
      companyId: { in: companyIds },
      type: "PROCEDURAL",
      status: "APPROVED",
      confidence: { gte: 0.8 },
    },
    select: { id: true, content: true, companyId: true, metadata: true },
  });

  // Group by content similarity — find patterns that appear in 2+ companies
  const patterns = new Map<string, Set<string>>(); // pattern key → set of companyIds

  for (const mem of proceduralMemories) {
    // Create a rough content key (first 100 chars normalized)
    const key = mem.content.toLowerCase().trim().slice(0, 100).replace(/\s+/g, " ");
    if (!patterns.has(key)) patterns.set(key, new Set());
    patterns.get(key)!.add(mem.companyId);
  }

  for (const [_key, companies] of patterns) {
    if (companies.size >= 2) {
      // This pattern appears in 2+ companies → holding brain candidate
      candidates++;
      logger.info(
        { tenantId, companiesCount: companies.size },
        "Holding brain promotion candidate found",
      );
      // In production: create a "holding brain" memory item or flag for review
    }
  }

  return candidates;
}

/**
 * Simple word-overlap similarity (Jaccard-like).
 */
function contentOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  return intersection / Math.max(wordsA.size, wordsB.size);
}
