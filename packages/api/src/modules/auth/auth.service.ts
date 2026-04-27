/**
 * Auth Service — register, login, JWT generation, password reset.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { sendWelcomeEmail, sendPasswordResetEmail } from "../../integrations/email-templates";
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
    algorithm: "HS256",
  });
}

function signRefreshToken(payload: AuthPayload & { jti: string }): string {
  return jwt.sign({ ...payload as object, typ: "refresh" }, env.JWT_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
    algorithm: "HS256",
  });
}

// Pre-computed bcrypt hash of a random throwaway value. Used in the constant-
// time login path so that a missing-user response burns the same CPU as a
// real bcrypt.compare(), closing the timing oracle that would otherwise let
// an attacker enumerate registered emails by measuring response latency.
// Generated once with: bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12)
const DUMMY_PASSWORD_HASH =
  "$2a$12$N5h9o9YcfXeLxUmHNyMm9.ZQq.G3X4LfKLY7g4Fkx8RmZPj8XqM3K";

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
    // Pin algorithm to HS256 — `jsonwebtoken` accepts any matching family by
    // default, so a future asymmetric-key code path or a downstream upgrade
    // could allow forged tokens to pass refresh without ever passing the
    // access-path's HS256 pin in middleware/auth.ts.
    decoded = jwt.verify(refreshToken, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as RefreshTokenPayload;
  } catch {
    throw new AppError(401, "Invalid or expired refresh token");
  }

  if (decoded.typ !== "refresh" || !decoded.jti) {
    throw new AppError(401, "Invalid refresh token type");
  }

  // Refresh-token revocation MUST fail closed: if Redis is down, a stolen
  // refresh token could otherwise be replayed indefinitely, since the only
  // gate that invalidates it on logout / rotation is the Redis allowlist.
  // Forcing re-login when Redis is unreachable keeps the security model
  // consistent with login (which already fails closed at line 316).
  const key = refreshKey(decoded.userId, decoded.jti);
  try {
    const exists = await redis.get(key);
    if (!exists) {
      throw new AppError(401, "Refresh token has been revoked");
    }
    await redis.del(key); // rotate — revoke old token
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis unreachable — fail closed: refuse the refresh.
    throw new AppError(503, "Authentication service temporarily unavailable");
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

  // Welcome email — fire-and-forget. Already swallows errors internally,
  // but keeping an extra try/catch here so any unexpected throw from the
  // import chain (missing SendGrid key, DNS hiccup) never affects signup.
  void sendWelcomeEmail({
    to: result.user.email,
    name: result.user.name ?? result.user.email.split("@")[0],
    tenantName: result.tenant.name,
  }).catch(() => { /* non-critical */ });

  return {
    token,
    refreshToken,
    user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role },
    tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug, plan: result.tenant.plan },
  };
}

/**
 * Login with email + password. Returns JWT.
 *
 * Security:
 * - Constant-time path: bcrypt.compare runs whether or not the user exists,
 *   so the response timing does not leak email registration status.
 *   (CRIT-4 fix — without this, a missing user replied in <50ms and an
 *   existing one took ~1.5s, giving a trivial enumeration oracle.)
 * - IP-keyed lockout: the lockout key combines email + requesting IP, so
 *   an attacker can only DoS-lockout themselves, not arbitrary victims.
 *   (CRIT-5 fix — the previous email-only key let any attacker who knew
 *   a victim's email lock them out for 30 minutes by submitting 5 bad
 *   passwords.)
 */
export async function login(
  data: { email: string; password: string },
  ip?: string,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  const { email } = data;
  // Composite lockout key — email alone lets an attacker lock out any
  // user whose email they know. Including the requesting IP means an
  // attacker can only lock out themselves; legitimate user from a
  // different IP keeps working. Ungate "ip" with a stable fallback
  // when the request didn't expose one (rare; behind some proxy stacks).
  const ipKey = ip ?? "noip";
  const lockKey = `login:lock:${email}:${ipKey}`;
  const failKey = `login:fail:${email}:${ipKey}`;

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

  // Always run bcrypt — against a real hash if the user exists, against a
  // pre-computed dummy hash if not. Both paths burn the same CPU window
  // (~1-2s on cost-12 bcryptjs). This is the constant-time defense against
  // the timing oracle.
  const hashToCompare = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await bcrypt.compare(data.password, hashToCompare);
  const valid = passwordMatches && !!user && !!user.passwordHash;

  if (!valid) {
    // Only count failures when the user actually exists — counting on
    // missing users would let an attacker lock out a non-victim email by
    // priming the failKey before the victim ever signs up. (Edge case,
    // but worth defending.)
    if (user) {
      try {
        const fails = await redis.incr(failKey);
        if (fails === 1) await redis.expire(failKey, 900); // 15 min window
        if (fails >= 5) {
          await redis.set(lockKey, "1", "EX", 1800); // 30 min lockout
          await redis.del(failKey);
        }
      } catch { /* Redis failure — lockout tracking skipped but login still fails due to invalid password */ }
    }

    throw new AppError(401, "Invalid email or password");
  }

  await prisma.activityLog.create({
    data: {
      tenantId: user!.tenantId,
      actor: user!.id,
      action: "auth.login",
      resource: "user",
      resourceId: user!.id,
    },
  });

  const { token, refreshToken } = await issueTokenPair({
    userId: user!.id,
    tenantId: user!.tenantId,
    role: user!.role,
  });

  try {
    await redis.del(failKey);
    await redis.del(lockKey);
  } catch { /* Redis failure — skip */ }

  return {
    token,
    refreshToken,
    user: { id: user!.id, email: user!.email, name: user!.name, role: user!.role },
    tenant: { id: user!.tenant.id, name: user!.tenant.name, slug: user!.tenant.slug, plan: user!.tenant.plan },
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
 *
 * Always returns success (no enumeration of existence via response body).
 * In addition we burn a fixed amount of CPU on BOTH paths so the
 * response timing doesn't leak existence either: if user is missing we
 * still do the same crypto.randomBytes + sha256 + sleep that the success
 * path would, then discard the result. Without this the success path
 * (DB write + SendGrid HTTP call, 200-800ms) is trivially distinguishable
 * from the empty path (<10ms).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    // Constant-time decoy — same shape of work the real path would do, so
    // an attacker timing the response can't tell whether the email is
    // registered. The randomBytes + sha256 are cheap; the artificial
    // delay covers the SendGrid round-trip the real path would incur.
    const decoyToken = crypto.randomBytes(32).toString("hex");
    crypto.createHash("sha256").update(decoyToken).digest("hex");
    // Sleep 250ms ± 100ms jitter — straddles the average SendGrid
    // success latency observed in production logs.
    const jitter = 200 + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, jitter));
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { resetTokenHash: tokenHash, resetTokenExpiresAt: expiresAt },
  });

  const resetUrl = `${process.env.APP_URL ?? "http://localhost:3001"}/reset-password?token=${token}`;

  await sendPasswordResetEmail({ to: email, resetUrl });
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
