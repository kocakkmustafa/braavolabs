import { prisma } from "./db";
import { logger } from "./logger";

const EMBEDDING_DIM = 1536;

/**
 * Generate a vector embedding for text.
 *
 * 1. If VOYAGE_API_KEY is set → Voyage AI (production quality)
 * 2. Fallback → deterministic hash embedding (dev/testing)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (process.env.VOYAGE_API_KEY) {
    return voyageEmbed(text);
  }
  return hashEmbed(text);
}

async function voyageEmbed(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: [text], model: "voyage-3" }),
  });
  if (!res.ok) throw new Error(`Voyage API error: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

function hashEmbed(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIM);
  const words = text.toLowerCase().split(/\s+/);
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    for (let c = 0; c < word.length; c++) {
      const code = word.charCodeAt(c);
      const seed = code * 31 + c * 17 + w * 7;
      vec[Math.abs(seed) % EMBEDDING_DIM] += 1.0 / (1 + w * 0.1);
      vec[Math.abs(seed * 37 + 13) % EMBEDDING_DIM] -= 0.5 / (1 + w * 0.1);
    }
  }
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= mag;
  return Array.from(vec);
}

/**
 * Store embedding in memory_embeddings via raw SQL (pgvector).
 */
export async function storeEmbedding(
  memoryItemId: string,
  embedding: number[],
): Promise<void> {
  const vecStr = `[${embedding.join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO memory_embeddings (id, memory_item_id, embedding, created_at)
     VALUES (gen_random_uuid(), $1, $2::vector, NOW())
     ON CONFLICT (memory_item_id)
     DO UPDATE SET embedding = $2::vector`,
    memoryItemId,
    vecStr,
  );
  logger.debug({ memoryItemId }, "Embedding stored");
}

/**
 * Generate + store embedding for a memory item.
 */
export async function embedMemoryItem(memoryItemId: string): Promise<void> {
  const item = await prisma.memoryItem.findUnique({ where: { id: memoryItemId } });
  if (!item) throw new Error(`Memory item ${memoryItemId} not found`);
  const embedding = await generateEmbedding(item.content);
  await storeEmbedding(memoryItemId, embedding);
}
