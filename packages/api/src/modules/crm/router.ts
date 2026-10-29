import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";
import { syncContacts, syncDeals } from "@ai-company-os/integrations";
import { logger } from "../../lib/logger";
import { getActiveIntegration } from "../integration/checker";

export const crmRouter = Router();
crmRouter.use(authMiddleware);

// GET /api/v1/crm/contacts?companyId=xxx
crmRouter.get("/contacts", async (req, res, next) => {
  try {
    const { companyId, search } = req.query;
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const contacts = await prisma.contact.findMany({
      where: {
        companyId: company.id,
        ...(search && {
          OR: [
            { name: { contains: search as string, mode: "insensitive" } },
            { email: { contains: search as string, mode: "insensitive" } },
          ],
        }),
      },
      include: { deals: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json(contacts);
  } catch (err) { next(err); }
});

const createContactSchema = z.object({
  companyId: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
});

// POST /api/v1/crm/contacts
crmRouter.post("/contacts", async (req, res, next) => {
  try {
    const data = createContactSchema.parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const contact = await prisma.contact.create({
      data: {
        companyId: data.companyId,
        email: data.email,
        name: data.name,
        phone: data.phone,
        linkedinUrl: data.linkedinUrl,
        tags: data.tags ?? [],
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "contact.create",
        resource: "contact",
        resourceId: contact.id,
      },
    });

    res.status(201).json(contact);
  } catch (err) { next(err); }
});

// GET /api/v1/crm/deals?companyId=xxx
crmRouter.get("/deals", async (req, res, next) => {
  try {
    const { companyId } = req.query;
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const deals = await prisma.deal.findMany({
      where: { companyId: company.id },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(deals);
  } catch (err) { next(err); }
});

// POST /api/v1/crm/sync — trigger HubSpot sync
crmRouter.post("/sync", async (req, res, next) => {
  try {
    const { companyId } = z.object({ companyId: z.string() }).parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    // Only the company's own HubSpot connection may be used. A server-wide
    // token would let every tenant import the operator's HubSpot portal.
    const creds = await getActiveIntegration(company.id, "HUBSPOT");
    const accessToken = creds?.accessToken;
    const portalId = creds?.portalId;
    if (!accessToken || !portalId) {
      throw new AppError(400, "HubSpot is not connected for this company. Connect it under Integrations.");
    }

    const config = { accessToken, portalId };
    // The RLS extension brands the client type; the runtime object still has
    // every model delegate (and stays RLS-bound). Cast to the params' expected
    // shape — the sync writes CRM rows within this request's tenant context.
    const rlsClient = prisma as unknown as Parameters<typeof syncContacts>[2];
    const [contacts, deals] = await Promise.all([
      syncContacts(config, companyId, rlsClient),
      syncDeals(config, companyId, rlsClient),
    ]);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "crm.sync",
        resource: "company",
        resourceId: companyId,
        details: { contacts, deals },
      },
    });

    logger.info({ companyId, contacts, deals }, "HubSpot sync completed");
    res.json({ contacts, deals });
  } catch (err) { next(err); }
});
