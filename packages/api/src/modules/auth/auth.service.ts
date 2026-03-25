/**
 * Auth Service — register, login, JWT generation, password reset.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { sendEmail } from "../../integrations/email";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../../lib/db";
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

/**
 * Register a new tenant + user. Returns JWT.
 */
export async function register(data: {
  email: string;
  password: string;
  name: string;
  tenantName: string;
  ref?: string;
}): Promise<{ token: string; user: any; tenant: any }> {
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
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

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

  const token = signToken({
    userId: result.user.id,
    tenantId: result.tenant.id,
    role: result.user.role,
  });

  return {
    token,
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
}): Promise<{ token: string; user: any; tenant: any }> {
  const user = await prisma.user.findUnique({
    where: { email: data.email },
    include: { tenant: true },
  });

  if (!user || !user.passwordHash) {
    throw new AppError(401, "Invalid email or password");
  }

  const valid = await bcrypt.compare(data.password, user.passwordHash);
  if (!valid) {
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

  const token = signToken({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
  });

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan },
  };
}

/**
 * Get Google OAuth authorization URL.
 */
export function getGoogleAuthUrl(): string {
  const client = getGoogleClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
  });
}

/**
 * Handle Google OAuth callback — exchange code for tokens,
 * find or create user, return JWT.
 */
export async function googleCallback(
  code: string,
  ref?: string,
): Promise<{ token: string; user: any; tenant: any }> {
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

  const token = signToken({
    userId: user!.id,
    tenantId: user!.tenantId,
    role: user!.role,
  });

  return {
    token,
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
    subject: "Reset your AI Company OS password",
    body: `
      <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #10131a; color: #e1e2eb; border-radius: 16px;">
        <div style="margin-bottom: 24px;">
          <span style="background: linear-gradient(135deg, #00d1ff, #6d11ad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 700; font-size: 18px;">AI Company OS</span>
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
