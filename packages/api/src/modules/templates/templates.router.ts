/**
 * Template marketplace router.
 *
 * Mirrors the connector marketplace shape (Feature 8) so the UI can
 * lean on shared list / detail / install patterns. The big
 * difference: templates carry executable structure (pipelines +
 * agents + memory seeds) rather than tool bindings, so the install
 * endpoint runs a transactional materialise rather than a creds
 * write.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { systemScope } from "../../middleware/system-scope";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import {
  exportCompanyToTemplate,
  installTemplate,
  materialiseTemplate,
  rateTemplate,
  type CompanyTemplateSnapshot,
} from "./templates.service";

export const templatesRouter = Router();

// ── Public catalog ────────────────────────────────────────

templatesRouter.get("/", systemScope("route:templates-public"), async (req, res, next) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    const where: any = { visibility: "PUBLIC", isApproved: true };
    if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }];
    const list = await prisma.companyTemplate.findMany({
      where,
      orderBy: [{ ratingAvg: "desc" }, { installCount: "desc" }, { name: "asc" }],
      select: {
        id: true,
        slug: true,
        name: true,
        version: true,
        vendor: true,
        description: true,
        iconUrl: true,
        screenshotUrls: true,
        primitives: true,
        pricing: true,
        priceUsd: true,
        installCount: true,
        ratingAvg: true,
        ratingCount: true,
      },
    });
    res.json(list);
  } catch (err) { next(err); }
});


// ── Tenant surfaces ────────────────────────────────────────

const tenantRouter = Router();
// Auth is applied PER ROUTE, not as a pathless `tenantRouter.use(authMiddleware)`.
// This router is mounted ahead of the public `GET /:slug` (see below), so a
// router-level guard would 401 every public template lookup on its way past.
// Same reasoning as the per-route systemScope markers (BR-P0-004).

tenantRouter.get("/my-installs", authMiddleware, async (req, res, next) => {
  try {
    const installs = await prisma.templateInstall.findMany({
      where: { tenantId: req.auth!.tenantId },
      include: { template: { select: { slug: true, name: true, vendor: true, iconUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(installs);
  } catch (err) { next(err); }
});

const installSchema = z.object({ companyNameOverride: z.string().min(1).max(120).optional() });

tenantRouter.post("/:slug/install", authMiddleware, async (req, res, next) => {
  try {
    const body = installSchema.parse(req.body);
    const t = await prisma.companyTemplate.findUnique({ where: { slug: req.params.slug } });
    if (!t) throw new AppError(404, "Template not found");
    if (t.pricing === "PAID") {
      throw new AppError(
        402,
        "This template requires checkout. POST /marketplace/templates/{slug}/checkout to start the Stripe flow.",
      );
    }
    const result = await installTemplate(t.id, req.auth!.tenantId, body);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

const checkoutSchema = z.object({
  paymentIntentId: z.string().min(1).max(200),
  companyNameOverride: z.string().min(1).max(120).optional(),
});

// PAID-template install hook: the SPA owns Stripe Checkout (separate
// from this endpoint); on success Stripe returns a paymentIntentId
// which the SPA POSTs here. The service verifies the payment intent
// belongs to the right template / tenant / amount before
// materialising the install. The Stripe-side verification step is
// the operator's responsibility — the Stripe webhook handler
// processes the canonical confirmation event.
tenantRouter.post("/:slug/install-paid", authMiddleware, async (req, res, next) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const t = await prisma.companyTemplate.findUnique({ where: { slug: req.params.slug } });
    if (!t || t.pricing !== "PAID") throw new AppError(404, "Paid template not found");
    if (!t.priceUsd) throw new AppError(500, "Template missing price");
    const result = await materialiseTemplate(
      t.id,
      req.auth!.tenantId,
      t.snapshot as unknown as CompanyTemplateSnapshot,
      {
        companyNameOverride: body.companyNameOverride,
        pricePaidUsd: Number(t.priceUsd),
        stripePaymentIntentId: body.paymentIntentId,
      },
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().max(2000).optional(),
});

tenantRouter.post("/:slug/rate", authMiddleware, async (req, res, next) => {
  try {
    const body = rateSchema.parse(req.body);
    const t = await prisma.companyTemplate.findUnique({ where: { slug: req.params.slug } });
    if (!t) throw new AppError(404, "Template not found");
    await rateTemplate(t.id, req.auth!.tenantId, body.rating, body.review);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Publish flow ──────────────────────────────────────────

const publishSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/),
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
  vendor: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  iconUrl: z.string().url().max(500).optional(),
  screenshotUrls: z.array(z.string().url().max(500)).max(5).default([]),
  // The company this template freezes. Must belong to the publisher
  // tenant.
  sourceCompanyId: z.string().min(1),
  pricing: z.enum(["FREE", "PAID"]).default("FREE"),
  priceUsd: z.number().min(1).max(10_000).optional(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).default("PRIVATE"),
});

tenantRouter.post("/publish", authMiddleware, async (req, res, next) => {
  try {
    const body = publishSchema.parse(req.body);
    if (body.pricing === "PAID" && !body.priceUsd) {
      throw new AppError(400, "PAID templates require priceUsd");
    }
    const snapshot = await exportCompanyToTemplate(body.sourceCompanyId, req.auth!.tenantId);
    const existing = await prisma.companyTemplate.findUnique({ where: { slug: body.slug } });
    if (existing && existing.publisherTenantId !== req.auth!.tenantId) {
      throw new AppError(409, "Template slug already taken by another publisher");
    }
    const t = await prisma.companyTemplate.upsert({
      where: { slug: body.slug },
      create: {
        slug: body.slug,
        name: body.name,
        version: body.version,
        vendor: body.vendor,
        description: body.description,
        iconUrl: body.iconUrl,
        screenshotUrls: body.screenshotUrls as any,
        snapshot: snapshot as any,
        primitives: snapshot.primitives as any,
        pricing: body.pricing,
        priceUsd: body.priceUsd,
        visibility: body.visibility,
        publisherTenantId: req.auth!.tenantId,
        isApproved: body.visibility !== "PUBLIC",
      },
      update: {
        name: body.name,
        version: body.version,
        vendor: body.vendor,
        description: body.description,
        iconUrl: body.iconUrl,
        screenshotUrls: body.screenshotUrls as any,
        snapshot: snapshot as any,
        primitives: snapshot.primitives as any,
        pricing: body.pricing,
        priceUsd: body.priceUsd,
        visibility: body.visibility,
        // PUBLIC version bump → require re-approval to defend
        // against a published-then-swapped malicious snapshot.
        isApproved: body.visibility !== "PUBLIC" ? true : !!(existing?.isApproved && existing.version === body.version),
      },
    });
    res.json({
      id: t.id,
      slug: t.slug,
      version: t.version,
      isApproved: t.isApproved,
      pendingReview: !t.isApproved && t.visibility === "PUBLIC",
    });
  } catch (err) { next(err); }
});

// Admin approval gate, env-listed admin emails (same approach as the
// connector marketplace).
tenantRouter.post("/:slug/approve", authMiddleware, async (req, res, next) => {
  try {
    const adminEmails = (process.env.MARKETPLACE_ADMIN_EMAILS ?? "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
    if (!me || !adminEmails.includes(me.email.toLowerCase())) {
      throw new AppError(403, "Template moderation is restricted to platform admins");
    }
    await prisma.companyTemplate.update({ where: { slug: req.params.slug }, data: { isApproved: true } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

templatesRouter.use(tenantRouter);

// ── Public template detail — registered LAST, deliberately ──────────────────
//
// `GET /:slug` matches any single segment, so wherever it sits, every literal
// sibling route with the same verb and segment count registered AFTER it
// becomes unreachable. `GET /marketplace/templates/my-installs` was answering
// 404 "Template not found" instead of reaching its handler for exactly this
// reason. Keeping the catch-all last is what makes the literal routes above
// win. Same shadowing class as the index.ts mount-order rule, one level down.
templatesRouter.get("/:slug", systemScope("route:templates-public"), async (req, res, next) => {
  try {
    const t = await prisma.companyTemplate.findUnique({ where: { slug: req.params.slug } });
    if (!t) throw new AppError(404, "Template not found");
    if (t.visibility !== "PUBLIC" || !t.isApproved) throw new AppError(404, "Template not found");
    const ratings = await prisma.templateRating.findMany({
      where: { templateId: t.id, review: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { rating: true, review: true, createdAt: true },
    });
    res.json({ ...t, recentRatings: ratings });
  } catch (err) { next(err); }
});
