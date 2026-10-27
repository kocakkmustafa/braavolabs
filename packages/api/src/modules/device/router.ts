/** Push authority is versioned; ordinary login and notification preferences
 * remain compatible with legacy clients. Legacy device rows never fan out. */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { cleanupPushSession } from "../../lib/pushCleanup";
import { registerPushDevice, updatePushDeviceLocale, unregisterLegacyPushDevice, pushUpgradeRequired } from "../../lib/pushOwnership";
import { NOTIFICATION_LOCALES, notificationLocaleFromHeader } from "../../lib/notificationLocale";

export const deviceRouter = Router();
// Body refresh proof permits cleanup after access expiry, without acquiring a
// new token or borrowing current account credentials. No cookie credentials.
deviceRouter.delete("/push-session", async (req, res, next) => {
  try { await cleanupPushSession(req); res.json({ success: true }); }
  catch (error) { next(error); }
});
deviceRouter.use(authMiddleware);

const registerSchema = z.object({
  token: z.string().min(10).max(512),
  platform: z.enum(["ios", "android", "web"]),
  // Accepted for legacy clients; never stored (lib/pushOwnership.ts).
  deviceName: z.string().max(120).nullable().optional(),
  osVersion: z.string().max(40).nullable().optional(),
  locale: z.enum(NOTIFICATION_LOCALES).optional(),
  revision: z.number().int().min(1).max(2147483647),
});

deviceRouter.post("/push-token", async (req, res, next) => {
  try {
    if (!req.auth!.pushSessionId || req.body?.revision == null) throw pushUpgradeRequired();
    const { locale: requestedLocale, ...input } = registerSchema.parse(req.body);
    const locale = requestedLocale ?? notificationLocaleFromHeader(req.headers["accept-language"]);
    res.json(await registerPushDevice(req.auth!, { ...input, locale }));
  } catch (error) { next(error); }
});

deviceRouter.patch("/push-token/locale", async (req, res, next) => {
  try {
    if (!req.auth!.pushSessionId || req.body?.revision == null) throw pushUpgradeRequired();
    const { token, locale, revision } = z.object({ token: z.string().min(10).max(512),
      locale: z.enum(NOTIFICATION_LOCALES), revision: z.number().int().min(1).max(2147483647),
    }).parse(req.body);
    res.json({ success: await updatePushDeviceLocale(req.auth!, token, revision, locale) });
  } catch (error) { next(error); }
});

// Legacy logout is harmless to versioned bindings, including same-user relogin.
deviceRouter.delete("/push-token", async (req, res, next) => {
  try {
    const { token } = z.object({ token: z.string().min(10).max(512) }).parse(req.body);
    await unregisterLegacyPushDevice(req.auth!, token);
    res.json({ success: true });
  } catch (error) { next(error); }
});

deviceRouter.get("/notification-prefs", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const existing = await prisma.notificationPref.findUnique({ where: { userId } });
    if (existing) {
      res.json({
        approvals: existing.approvals,
        risks: existing.risks,
        runs: existing.runs,
        drafts: existing.drafts,
      });
      return;
    }
    // Defaults match schema column defaults — see prisma/schema.prisma.
    res.json({ approvals: true, risks: true, runs: false, drafts: false });
  } catch (err) {
    next(err);
  }
});

const prefsUpdateSchema = z
  .object({
    approvals: z.boolean(),
    risks: z.boolean(),
    runs: z.boolean(),
    drafts: z.boolean(),
  })
  .partial();

deviceRouter.patch("/notification-prefs", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const patch = prefsUpdateSchema.parse(req.body);

    const updated = await prisma.notificationPref.upsert({
      where: { userId },
      create: { userId, ...patch },
      update: patch,
    });

    res.json({
      success: true,
      approvals: updated.approvals,
      risks: updated.risks,
      runs: updated.runs,
      drafts: updated.drafts,
    });
  } catch (err) {
    next(err);
  }
});
