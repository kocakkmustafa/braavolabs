/**
 * Auth Service — register, login, JWT generation, password reset.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { sendEmail } from "../../integrations/email";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../../lib/db";
import { redis } from "../../lib/redis";
import { env } from "../../config/env";
import { AppError } from "../../middleware/error";
import type { AuthPayload } from "../../middleware/auth";

function getGoogleClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, "Google OAuth not configured");
  }
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

function signToken(payload: AuthPayload): string {
  return jwt.sign(payload as object, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
  });
}

function signRefreshToken(payload: AuthPayload & { jti: string }): string {
  return jwt.sign({ ...payload as object, typ: "refresh" }, env.JWT_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
  });
}

const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function refreshKey(userId: string, jti: string): string {
  return `refresh:${userId}:${jti}`;
}

async function issueTokenPair(payload: AuthPayload): Promise<{ token: string; refreshToken: string }> {
  const token = signToken(payload);
  const jti = crypto.randomBytes(16).toString("hex");
  const refreshToken = signRefreshToken({ ...payload, jti });

  try {
    await redis.set(refreshKey(payload.userId, jti), "1", "EX", REFRESH_TTL_SECONDS);
  } catch {
    // Redis unavailable — refresh tokens work but can't be revoked
  }

  return { token, refreshToken };
}

type RefreshTokenPayload = AuthPayload & {
  typ?: string;
  jti?: string;
};

export async function refreshTokens(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_SECRET) as RefreshTokenPayload;
  } catch {
    throw new AppError(401, "Invalid or expired refresh token");
  }

  if (decoded.typ !== "refresh" || !decoded.jti) {
    throw new AppError(401, "Invalid refresh token type");
  }

  const key = refreshKey(decoded.userId, decoded.jti);
  try {
    const exists = await redis.get(key);
    if (!exists) {
      throw new AppError(401, "Refresh token has been revoked");
    }
    await redis.del(key); // rotate — revoke old token
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis down — allow without revocation check
  }

  const payload: AuthPayload = {
    userId: decoded.userId,
    tenantId: decoded.tenantId,
    role: decoded.role,
  };

  return issueTokenPair(payload);
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  try {
    const keys = await redis.keys(`refresh:${userId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis unavailable — silently continue
  }
}

/**
 * Disposable / throwaway email domains. Registering with one of these is
 * almost always abuse — bot signups racking up free-plan run quota. The
 * list is intentionally short (covers the common providers); we'd rather
 * miss a few than block a legitimate signup. A real email-verification
 * flow is the long-term fix; this is a launch-day gate while that's
 * being built.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "mailinator.com",
  "mailinator.net",
  "trashmail.com",
  "trashmail.net",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  "fakeinbox.com",
  "sharklasers.com",
  "getnada.com",
  "maildrop.cc",
  "dispostable.com",
  "tempinbox.com",
  "mintemail.com",
  "inboxbear.com",
  "33mail.com",
  "spamgourmet.com",
  "tutanota.com",
  "mohmal.com",
  "incognitomail.com",
  "emailondeck.com",
  "burnermail.io",
]);

function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * Register a new tenant + user. Returns JWT.
 */
export async function register(data: {
  email: string;
  password: string;
  name: string;
  tenantName: string;
  ref?: string;
}): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  // Block disposable / throwaway emails — abuse mitigation for the
  // missing email-verification flow.
  if (isDisposableEmail(data.email)) {
    throw new AppError(
      400,
      "Disposable email addresses are not accepted. Please sign up with a permanent email.",
    );
  }

  // Check existing
  const existing = await prisma.user.findUnique({
    where: { email: data.email },
  });
  if (existing) {
    throw new AppError(409, "Email already registered");
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  // Create tenant + user in transaction
  const result = await prisma.$transaction(async (tx) => {
    const slug = data.tenantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      + "-" + Date.now().toString(36);

    const tenant = await tx.tenant.create({
      data: {
        name: data.tenantName,
        slug,
        plan: "FREE",
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: data.email,
        name: data.name,
        passwordHash,
        role: "OWNER",
      },
    });

    await tx.activityLog.create({
      data: {
        tenantId: tenant.id,
        actor: user.id,
        action: "auth.register",
        resource: "user",
        resourceId: user.id,
      },
    });

    return { tenant, user };
  });

  // Handle referral
  if (data.ref) {
    try {
      const referral = await prisma.referral.findUnique({
        where: { referralCode: data.ref },
      });
      if (referral && referral.status === "PENDING") {
        const now = new Date();
        // UTC anchored — must match metering.ts so referral credit lands
        // in the same monthly bucket the referred tenant's runs do.
        const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

        await prisma.referral.update({
          where: { id: referral.id },
          data: {
            referredTenantId: result.tenant.id,
            status: "CONVERTED",
            convertedAt: new Date(),
            rewardType: "extra_runs",
            rewardApplied: true,
          },
        });

        // Bonus runs for both
        for (const tid of [referral.referrerTenantId, result.tenant.id]) {
          await prisma.usageMeter.upsert({
            where: { tenantId_metric_periodStart: { tenantId: tid, metric: "bonus_runs", periodStart } },
            update: { value: { increment: 5 } },
            create: { tenantId: tid, metric: "bonus_runs", value: 5, periodStart, periodEnd },
          });
        }

        await prisma.activityLog.create({
          data: {
            tenantId: referral.referrerTenantId,
            actor: "system",
            action: "referral.signup",
            resource: "referral",
            resourceId: referral.id,
            details: { referredTenantId: result.tenant.id },
          },
        });
      }
    } catch {
      // Don't fail registration over referral errors
    }
  }

  const { token, refreshToken } = await issueTokenPair({
    userId: result.user.id,
    tenantId: result.tenant.id,
    role: result.user.role,
  });

  return {
    token,
    refreshToken,
    user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role },
    tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug, plan: result.tenant.plan },
  };
}

/**
 * Login with email + password. Returns JWT.
 */
export async function login(data: {
  email: string;
  password: string;
}): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  const { email } = data;

  // Account lockout check
  const lockKey = `login:lock:${email}`;
  const failKey = `login:fail:${email}`;

  try {
    const locked = await redis.get(lockKey);
    if (locked) {
      throw new AppError(429, "Account temporarily locked. Try again in 30 minutes.");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis down — fail closed for login security
    throw new AppError(503, "Authentication service temporarily unavailable");
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { tenant: true },
  });

  if (!user || !user.passwordHash) {
    throw new AppError(401, "Invalid email or password");
  }

  const valid = await bcrypt.compare(data.password, user.passwordHash);
  if (!valid) {
    try {
      const fails = await redis.incr(failKey);
      if (fails === 1) await redis.expire(failKey, 900); // 15 min window
      if (fails >= 5) {
        await redis.set(lockKey, "1", "EX", 1800); // 30 min lockout
        await redis.del(failKey);
      }
    } catch { /* Redis failure — lockout tracking skipped but login still fails due to invalid password */ }

    throw new AppError(401, "Invalid email or password");
  }

  await prisma.activityLog.create({
    data: {
      tenantId: user.tenantId,
      actor: user.id,
      action: "auth.login",
      resource: "user",
      resourceId: user.id,
    },
  });

  const { token, refreshToken } = await issueTokenPair({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
  });

  try {
    await redis.del(failKey);
    await redis.del(lockKey);
  } catch { /* Redis failure — skip */ }

  return {
    token,
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan },
  };
}

/**
 * Get Google OAuth authorization URL.
 */
export function getGoogleAuthUrl(state?: string): string {
  const client = getGoogleClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
    ...(state && { state }),
  });
}

/**
 * Handle Google OAuth callback — exchange code for tokens,
 * find or create user, return JWT.
 */
export async function googleCallback(
  code: string,
  ref?: string,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  const client = getGoogleClient();

  // Exchange code for tokens
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new AppError(400, "Failed to get ID token from Google");
  }

  // Verify and decode the ID token
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID!,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) {
    throw new AppError(400, "Google account has no email");
  }

  const { sub: googleId, email, name, picture } = payload;

  // Check if user exists by googleId or email
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { googleId: googleId },
        { email },
      ],
    },
    include: { tenant: true },
  });

  if (user) {
    // Link Google ID if not already linked
    if (!user.googleId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { googleId, avatarUrl: picture ?? user.avatarUrl },
      });
    }

    await prisma.activityLog.create({
      data: {
        tenantId: user.tenantId,
        actor: user.id,
        action: "auth.google_login",
        resource: "user",
        resourceId: user.id,
      },
    });
  } else {
    // Create new tenant + user
    const slug =
      (name ?? email.split("@")[0])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") +
      "-" +
      Date.now().toString(36);

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: name ?? email.split("@")[0], slug, plan: "FREE" },
      });

      const newUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: name ?? null,
          avatarUrl: picture ?? null,
          googleId: googleId ?? null,
          role: "OWNER",
        },
      });

      await tx.activityLog.create({
        data: {
          tenantId: tenant.id,
          actor: newUser.id,
          action: "auth.google_register",
          resource: "user",
          resourceId: newUser.id,
        },
      });

      return { tenant, user: newUser };
    });

    user = { ...result.user, tenant: result.tenant } as any;

    // Handle referral for new sign-ups
    if (ref) {
      try {
        const referral = await prisma.referral.findUnique({
          where: { referralCode: ref },
        });
        if (referral && referral.status === "PENDING") {
          const now = new Date();
          const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

          await prisma.referral.update({
            where: { id: referral.id },
            data: {
              referredTenantId: user!.tenantId,
              status: "CONVERTED",
              convertedAt: new Date(),
              rewardType: "extra_runs",
              rewardApplied: true,
            },
          });

          for (const tid of [referral.referrerTenantId, user!.tenantId]) {
            await prisma.usageMeter.upsert({
              where: { tenantId_metric_periodStart: { tenantId: tid, metric: "bonus_runs", periodStart } },
              update: { value: { increment: 5 } },
              create: { tenantId: tid, metric: "bonus_runs", value: 5, periodStart, periodEnd },
            });
          }
        }
      } catch {
        // Don't fail over referral errors
      }
    }
  }

  const { token, refreshToken } = await issueTokenPair({
    userId: user!.id,
    tenantId: user!.tenantId,
    role: user!.role,
  });

  return {
    token,
    refreshToken,
    user: { id: user!.id, email: user!.email, name: user!.name, role: user!.role },
    tenant: { id: user!.tenant.id, name: user!.tenant.name, slug: user!.tenant.slug, plan: user!.tenant.plan },
  };
}

/**
 * Request password reset — generates token, stores hash, sends email.
 * Always returns success to prevent email enumeration.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always return success to prevent email enumeration
  if (!user || !user.passwordHash) return;

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { resetTokenHash: tokenHash, resetTokenExpiresAt: expiresAt },
  });

  const resetUrl = `${process.env.APP_URL ?? "http://localhost:3001"}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Reset your Braavolabs password",
    body: `
      <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #10131a; color: #e1e2eb; border-radius: 16px;">
        <div style="margin-bottom: 24px;">
          <span style="background: linear-gradient(135deg, #00d1ff, #6d11ad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 700; font-size: 18px;">Braavolabs</span>
        </div>
        <h2 style="color: #e1e2eb; margin-bottom: 12px;">Reset your password</h2>
        <p style="color: #859399; margin-bottom: 24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #00d1ff, #6d11ad); color: white; padding: 12px 28px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 14px;">Reset Password</a>
        <p style="color: #3c494e; font-size: 12px; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

/**
 * Reset password with token.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const user = await prisma.user.findFirst({
    where: {
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: { gt: new Date() },
    },
  });

  if (!user) throw new AppError(400, "Invalid or expired reset token");

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, resetTokenHash: null, resetTokenExpiresAt: null },
  });
}
