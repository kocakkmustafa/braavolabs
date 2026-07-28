import { prisma } from "../../lib/db";

/**
 * YULA_INTERNAL tenant (KK-2026-07-27 dogfood): the holding lives in the
 * product as a REAL tenant so its runs light up desktop/mobile/CLI surfaces.
 * This slug is the single identity the Anayasa §3 ToS guard recognises as
 * "holding's own work" — subscription/BYOK use is permitted ONLY here.
 */
export const YULA_TENANT_SLUG = "yula-internal";

export async function ensureYulaTenant() {
  return prisma.tenant.upsert({
    where: { slug: YULA_TENANT_SLUG },
    create: { name: "YULA Holding", slug: YULA_TENANT_SLUG },
    update: {},
  });
}
