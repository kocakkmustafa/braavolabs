import { Client } from "@hubspot/api-client";
import type { PrismaClient } from "@prisma/client";

/** Accepts the base client OR an $extends()-wrapped one (RLS-bound) — only the
 * contact + deal model delegates are used, so a structural subset keeps both. */
type HubSpotPrisma = Pick<PrismaClient, "contact" | "deal">;
import pino from "pino";

const logger = pino({ name: "hubspot" });

export interface HubSpotConfig {
  accessToken: string;
  portalId: string;
}

function createClient(config: HubSpotConfig): Client {
  return new Client({ accessToken: config.accessToken });
}

/**
 * Sync contacts from HubSpot into the local contacts table.
 */
export async function syncContacts(
  config: HubSpotConfig,
  companyId: string,
  prisma: HubSpotPrisma,
): Promise<{ created: number; updated: number }> {
  const hubspot = createClient(config);
  let created = 0;
  let updated = 0;
  let after: string | undefined;

  do {
    const response = await hubspot.crm.contacts.basicApi.getPage(
      100,
      after,
      ["email", "firstname", "lastname", "phone", "linkedinbio"],
    );

    for (const contact of response.results) {
      const email = contact.properties.email;
      if (!email) continue;

      const name = [contact.properties.firstname, contact.properties.lastname]
        .filter(Boolean)
        .join(" ") || undefined;

      const existing = await prisma.contact.findFirst({
        where: { hubspotId: contact.id },
      });

      if (existing) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: {
            email,
            name,
            phone: contact.properties.phone ?? undefined,
            linkedinUrl: contact.properties.linkedinbio ?? undefined,
            properties: contact.properties as any,
          },
        });
        updated++;
      } else {
        await prisma.contact.create({
          data: {
            companyId,
            email,
            name,
            phone: contact.properties.phone ?? undefined,
            linkedinUrl: contact.properties.linkedinbio ?? undefined,
            hubspotId: contact.id,
            properties: contact.properties as any,
          },
        });
        created++;
      }
    }

    after = response.paging?.next?.after;
  } while (after);

  logger.info({ companyId, created, updated }, "HubSpot contacts synced");
  return { created, updated };
}

/**
 * Sync deals from HubSpot.
 */
export async function syncDeals(
  config: HubSpotConfig,
  companyId: string,
  prisma: HubSpotPrisma,
): Promise<{ created: number; updated: number }> {
  const hubspot = createClient(config);
  let created = 0;
  let updated = 0;
  let after: string | undefined;

  do {
    const response = await hubspot.crm.deals.basicApi.getPage(
      100,
      after,
      ["dealname", "dealstage", "amount", "closedate"],
      undefined,
      ["contacts"],
    );

    for (const deal of response.results) {
      const existing = await prisma.deal.findFirst({
        where: { hubspotId: deal.id },
      });

      // Find associated contact
      const contactAssoc = deal.associations?.contacts?.results?.[0];
      let contactId: string | null = null;

      if (contactAssoc) {
        const contact = await prisma.contact.findFirst({
          where: { hubspotId: String(contactAssoc.id) },
        });
        contactId = contact?.id ?? null;
      }

      if (!contactId) continue; // Skip deals without linked contacts

      const dealData = {
        title: deal.properties.dealname ?? "Untitled Deal",
        stage: deal.properties.dealstage ?? "lead",
        amountUsd: deal.properties.amount ? parseFloat(deal.properties.amount) : undefined,
        closedAt: deal.properties.closedate ? new Date(deal.properties.closedate) : undefined,
        properties: deal.properties as any,
      };

      if (existing) {
        await prisma.deal.update({ where: { id: existing.id }, data: dealData });
        updated++;
      } else {
        await prisma.deal.create({
          data: { ...dealData, companyId, contactId, hubspotId: deal.id },
        });
        created++;
      }
    }

    after = response.paging?.next?.after;
  } while (after);

  logger.info({ companyId, created, updated }, "HubSpot deals synced");
  return { created, updated };
}

/**
 * Push a local contact to HubSpot.
 */
export async function createHubSpotContact(
  config: HubSpotConfig,
  contact: { email: string; name?: string; phone?: string },
): Promise<string> {
  const hubspot = createClient(config);
  const [firstname, ...rest] = (contact.name ?? "").split(" ");

  const response = await hubspot.crm.contacts.basicApi.create({
    properties: {
      email: contact.email,
      firstname: firstname ?? "",
      lastname: rest.join(" "),
      phone: contact.phone ?? "",
    },
    associations: [],
  });

  return response.id;
}
