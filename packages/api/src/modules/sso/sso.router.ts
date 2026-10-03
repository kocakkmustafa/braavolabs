/**
 * SSO router — two surfaces:
 *
 *   /api/v1/sso/oidc          owner-only config CRUD (BUSINESS+)
 *   /api/v1/auth/sso/:slug    public-ish auth flow (init + callback)
 *
 * The auth flow lives under /auth/ instead of /sso/ so it matches the
 * shape of the Google + GitHub OAuth routes already mounted there —
 * one mental model for "redirect-based sign-in flows" rather than
 * scattering them across modules. The OAuth exchange-code pattern
 * from SEC-006 is reused: the IdP callback emits a code in the
 * redirect URL, the SPA POSTs to /auth/oauth/exchange to redeem it.
 */

import { Router } from "express";
import { requirePermission } from "../../middleware/require-permission";
import { z } from "zod";
import crypto from "node:crypto";
import { authMiddleware } from "../../middleware/auth";
import { systemScope } from "../../middleware/system-scope";
import { rateLimit } from "../../middleware/rateLimit";
import { prisma } from "../../lib/db";
import { redis } from "../../lib/redis";
import { AppError } from "../../middleware/error";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import {
  SSO_PLANS,
  upsertOidcConnection,
  deleteOidcConnection,
  getOidcConfigSafe,
  buildAuthUrl,
  consumeCallback,
} from "./sso.service";
import { stashOAuthExchange, issueTokenPair } from "../auth/auth.service";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";

// ─── /sso/oidc — owner-only config CRUD ──────────────────────

export const ssoConfigRouter = Router();
ssoConfigRouter.use(authMiddleware);

async function requireSsoEnabledPlan(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });
  const plan = await getEffectivePlan(tenantId, tenant?.plan);
  if (!tenant || !SSO_PLANS.has(plan)) {
    throw new AppError(
      402,
      "Enterprise SSO is a Business or Enterprise feature. Visit /pricing to upgrade.",
    );
  }
}

ssoConfigRouter.get("/oidc", async (req, res, next) => {
  try {
    const cfg = await getOidcConfigSafe(req.auth!.tenantId);
    res.json(cfg);
  } catch (err) { next(err); }
});

const oidcUpsertSchema = z.object({
  issuer: z.string().url().max(500),
  clientId: z.string().min(1).max(200),
  // Required on create, optional on update (the existing encrypted
  // secret stays unless a new one is provided). The service layer
  // enforces the "required on create" branch.
  clientSecret: z.string().min(1).max(500).optional(),
  redirectUri: z.string().url().max(500),
  scopes: z.string().min(1).max(200).optional(),
  domains: z.string().max(500).optional(),
  discoveryUrl: z.string().url().max(500).optional(),
  isActive: z.boolean().optional(),
});

ssoConfigRouter.put("/oidc", requirePermission("sso:configure"), async (req, res, next) => {
  try {
    await requireSsoEnabledPlan(req.auth!.tenantId);
    const body = oidcUpsertSchema.parse(req.body);
    const result = await upsertOidcConnection(req.auth!.tenantId, body);
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "sso.oidc.upsert",
        resource: "oidc_connection",
        resourceId: result.id,
        details: { issuer: body.issuer, isActive: body.isActive ?? true },
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

ssoConfigRouter.delete("/oidc", requirePermission("sso:configure"), async (req, res, next) => {
  try {
    await deleteOidcConnection(req.auth!.tenantId);
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "sso.oidc.delete",
        resource: "oidc_connection",
        resourceId: req.auth!.tenantId,
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── /auth/sso/:tenantSlug — auth flow ────────────────────────

export const ssoAuthRouter = Router();
// BR-P0-004: pre-auth by definition — the SSO handshake establishes the
// session. ssoConfigRouter above is authMiddleware-gated and stays so.

const initRateLimit = rateLimit({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: "rl:sso:init",
});

// GET /api/v1/auth/sso/:tenantSlug  → redirect to IdP authorization
//
// Public — anyone with the tenant's slug can hit this. The IdP's own
// session enforcement is the real gate; we just need to know which
// connection to use.
ssoAuthRouter.get("/:tenantSlug", systemScope("route:sso-login"), initRateLimit, async (req, res, next) => {
  try {
    const slug = z.string().min(1).max(120).parse(req.params.tenantSlug);
    const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, plan: true } });
    if (!tenant) {
      // Avoid leaking which slugs exist — return a generic 404 page hint.
      res.status(404).json({ error: "SSO is not configured for this workspace" });
      return;
    }
    const plan = await getEffectivePlan(tenant.id, tenant.plan);
    if (!SSO_PLANS.has(plan)) {
      res.status(402).json({ error: "SSO is not available on this workspace's plan" });
      return;
    }
    const { url } = await buildAuthUrl(tenant.id, { redirectAfter: undefined });
    res.redirect(url);
  } catch (err) { next(err); }
});

// GET /api/v1/auth/sso/:tenantSlug/callback  → consume IdP response
ssoAuthRouter.get("/:tenantSlug/callback", systemScope("route:sso-login"), async (req, res, next) => {
  try {
    const { code, state, error } = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);

    if (error) {
      const redirectUrl = new URL("/login", env.APP_URL);
      redirectUrl.searchParams.set("sso_error", error.slice(0, 100));
      res.redirect(redirectUrl.toString());
      return;
    }
    if (!code || !state) {
      throw new AppError(400, "SSO callback missing code or state");
    }

    const profile = await consumeCallback({ code, state });

    // A subscription may expire during the IdP round trip. Recheck before
    // linking/creating a user or issuing a fresh session for this tenant.
    await requireSsoEnabledPlan(profile.tenantId);

    // Find-or-create user. Tenant is already bound by the connection
    // — we never let an SSO login wander into a different tenant. Two
    // lookup keys: (tenantId, oidcSubject) is the strongest; email
    // is a fallback for users who originally signed up with email/
    // password and are now linking SSO.
    let user = await prisma.user.findFirst({
      where: { tenantId: profile.tenantId, oidcSubject: profile.sub },
    });
    if (!user) {
      user = await prisma.user.findFirst({
        where: { tenantId: profile.tenantId, email: profile.email },
      });
    }
    if (!user) {
      // First-time SSO sign-in → provision a MEMBER user in the
      // connection's tenant. Role bump happens via the regular
      // settings → team UI; SSO never grants OWNER on its own.
      user = await prisma.user.create({
        data: {
          tenantId: profile.tenantId,
          email: profile.email,
          name: profile.name ?? null,
          avatarUrl: profile.picture ?? null,
          oidcSubject: profile.sub,
          role: "MEMBER",
        },
      });
    } else if (!user.oidcSubject) {
      // Existing user — link the SSO subject.
      user = await prisma.user.update({
        where: { id: user.id },
        data: { oidcSubject: profile.sub, avatarUrl: profile.picture ?? user.avatarUrl },
      });
    }

    await prisma.activityLog.create({
      data: {
        tenantId: profile.tenantId,
        actor: user.id,
        action: "auth.sso_login",
        resource: "user",
        resourceId: user.id,
      },
    });

    // Issue token bundle via the shared OAuth-exchange flow so the
    // browser never sees the bearer token in the URL.
    const tenantRow = await prisma.tenant.findUniqueOrThrow({ where: { id: profile.tenantId } });
    const tokens = await issueTokenPair({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    });
    const code2 = await stashOAuthExchange({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: { id: tenantRow.id, name: tenantRow.name, slug: tenantRow.slug, plan: tenantRow.plan },
    });
    const redirectUrl = new URL("/auth/callback", env.APP_URL);
    redirectUrl.searchParams.set("code", code2);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});
