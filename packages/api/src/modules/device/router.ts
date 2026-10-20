/**
 * Device & notification preference endpoints — consumed exclusively by
 * the mobile companion app (Apps/Braavo). Mirrors the contract in that
 * project's `lib/api.ts` (registerPushToken / unregisterPushToken /
 * get / updateNotificationPrefs).
 *
 *   POST   /api/v1/devices/push-token         — register / refresh a token
 *   DELETE /api/v1/devices/push-token         — unregister (logout)
 *   GET    /api/v1/devices/notification-prefs — read current prefs
 *   PATCH  /api/v1/devices/notification-prefs — partial update
 *
 * The push token itself is the only globally-unique identifier — Expo
 * rotates them on app reinstall, so we upsert by token. If the same
 * token shows up under a different user (account switch on the same
 * phone), we transfer ownership rather than insert a duplicate.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { NOTIFICATION_LOCALES, notificationLocaleFromHeader } from "../../lib/notificationLocale";

export const deviceRouter = Router();
deviceRouter.use(authMiddleware);

const registerSchema = z.object({
  token: z.string().min(10).max(512),
  platform: z.enum(["ios", "android", "web"]),
  deviceName: z.string().max(120).nullable().optional(),
  osVersion: z.string().max(40).nullable().optional(),
  locale: z.enum(NOTIFICATION_LOCALES).optional(),
});

deviceRouter.post("/push-token", async (req, res, next) => {
  try {
    const { token, platform, deviceName, osVersion, locale: requestedLocale } = registerSchema.parse(req.body);
    const locale = requestedLocale ?? notificationLocaleFromHeader(req.headers["accept-language"]);

    // Upsert: if this token already exists (same phone, possibly under a
    // different user after an account switch), reassign + refresh
    // metadata. Otherwise insert.
    await prisma.device.upsert({
      where: { pushToken: token },
      create: {
        userId: req.auth!.userId,
        pushToken: token,
        platform,
        deviceName: deviceName ?? null,
        osVersion: osVersion ?? null,
        locale,
      },
      update: {
        userId: req.auth!.userId,
        platform,
        deviceName: deviceName ?? null,
        osVersion: osVersion ?? null,
        // A token transferred to another account gets that request's locale.
        locale,
        lastSeenAt: new Date(),
      },
    });

    logger.info(
      { userId: req.auth!.userId, platform, deviceName },
      "Device push token registered",
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** Update an already registered device; never prompt/re-register native permissions. */
deviceRouter.patch("/push-token/locale", async (req, res, next) => {
  try {
    const { token, locale } = z.object({
      token: z.string().min(10).max(512),
      locale: z.enum(NOTIFICATION_LOCALES),
    }).parse(req.body);
    // One atomic ownership predicate; no lookup-then-update account race.
    const result = await prisma.device.updateMany({
      where: { pushToken: token, userId: req.auth!.userId },
      data: { locale },
    });
    res.json({ success: result.count > 0 });
  } catch (err) { next(err); }
});

const unregisterSchema = z.object({ token: z.string().min(10) });

deviceRouter.delete("/push-token", async (req, res, next) => {
  try {
    const { token } = unregisterSchema.parse(req.body);

    // Atomic ownership check: an old owner's delayed logout cannot delete a
    // token that was reassigned to a new account between lookup and deletion.
    await prisma.device.deleteMany({ where: { pushToken: token, userId: req.auth!.userId } });
    // Same response whether owned, absent or transferred; no existence oracle.
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
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
