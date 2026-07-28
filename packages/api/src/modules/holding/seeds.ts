import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { audit } from "./audit";
import workflowSeeds from "./seed-data/workflows.json";

/**
 * D4 seed: loads the governance-authored workflow catalog (28 definitions,
 * generated from yula-holding-governance tanimlar/workflows.yaml) into
 * holding_workflow_definitions. Idempotent upsert by key — re-running after
 * a governance update simply converges the DB to the file.
 *
 * enabled flags come from governance verbatim: dormant-by-design means the
 * catalog ships complete while only kapi-duman-testi starts enabled.
 */
export async function seedHoldingDefinitions(): Promise<{ total: number; enabled: number }> {
  let enabled = 0;
  for (const seed of workflowSeeds) {
    if (seed.enabled) enabled += 1;
    await prisma.holdingWorkflowDefinition.upsert({
      where: { key: seed.key },
      create: {
        key: seed.key,
        name: seed.name,
        description: seed.description,
        riskClass: seed.riskClass as never,
        autonomyLevel: seed.autonomyLevel,
        steps: seed.steps as object,
        enabled: seed.enabled,
      },
      update: {
        name: seed.name,
        description: seed.description,
        riskClass: seed.riskClass as never,
        autonomyLevel: seed.autonomyLevel,
        steps: seed.steps as object,
        enabled: seed.enabled,
      },
    });
  }
  await audit({
    actor: "holding.seeds",
    action: "holding.definitions_seeded",
    payload: { total: workflowSeeds.length, enabled },
  });
  logger.info({ total: workflowSeeds.length, enabled }, "holding workflow definitions seeded");
  return { total: workflowSeeds.length, enabled };
}
