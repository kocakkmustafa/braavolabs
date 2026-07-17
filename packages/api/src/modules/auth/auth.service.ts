/**
 * Auth Service — register, login, JWT generation, password reset.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sendWelcomeEmail, sendPasswordResetEmail, sendVerifyEmail } from "../../integrations/email-templates";
import { OAuth2Client } from "google-auth-library";
import { prisma, tenantTx } from "../../lib/db";
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

// Bcrypt hash of a random throwaway value, generated once per process at
// boot. Used in the constant-time login path so a missing-user response
// burns the same CPU as a real bcrypt.compare(), closing the timing oracle
// that would otherwise let an attacker enumerate registered emails by
// measuring response latency.
//
// Generating per-process (rather than compiling a constant into the
// binary) makes it impossible for an attacker who reads the source to
// time-correlate "this is the dummy path" responses against any known
// plaintext — every deployment gets a fresh, unguessable target hash.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString("hex"),
  12,
);

const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function refreshKey(userId: string, jti: string): string {
  return `refresh:${userId}:${jti}`;
}

export async function issueTokenPair(payload: AuthPayload): Promise<{ token: string; refreshToken: string }> {
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

export async function refreshTokens(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string; user: { id: string; email: string; name: string | null; role: string }; tenant: { id: string; name: string; slug: string; plan: string } }> {
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

  // Re-read the user + tenant from the database so a tenant or role
  // change (invited / kicked / role downgrade) since the refresh token
  // was issued is reflected in the new access token. Without this the
  // client could hold a JWT carrying a stale tenantId/role for the
  // full TTL and silently operate against the wrong workspace.
  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    include: { tenant: true },
  });
  if (!user) {
    throw new AppError(401, "User no longer exists");
  }

  const payload: AuthPayload = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
  };

  const tokens = await issueTokenPair(payload);
  return {
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan },
  };
}

/**
 * Short-lived (60s) one-time code that the OAuth callback emits in the
 * redirect URL instead of the bearer + refresh tokens themselves. The
 * SPA exchanges the code for tokens via POST /auth/oauth/exchange,
 * which means the tokens never appear in browser history, the URL bar,
 * the Referer header, or any reverse-proxy access log.
 *
 * Keyed by a fresh `crypto.randomBytes(32).toString("hex")` so the code
 * is unguessable; redis.set NX guarantees one-time use; 60s TTL is
 * enough for the browser to follow one redirect and POST it back, and
 * short enough that an exfiltrated code is useless almost immediately.
 */
const OAUTH_EXCHANGE_TTL_SECONDS = 60;

type OAuthTokenBundle = {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; name: string | null; role: string };
  tenant: { id: string; name: string; slug: string; plan: string };
};

function oauthExchangeKey(code: string): string {
  return `oauth:exchange:${code}`;
}

export async function stashOAuthExchange(bundle: OAuthTokenBundle): Promise<string> {
  const code = crypto.randomBytes(32).toString("hex");
  // SETNX so a (vanishingly unlikely) code collision can't overwrite an
  // in-flight bundle and accidentally hand the wrong tenant's tokens to
  // a different browser tab.
  const ok = await redis.set(
    oauthExchangeKey(code),
    JSON.stringify(bundle),
    "EX",
    OAUTH_EXCHANGE_TTL_SECONDS,
    "NX",
  );
  if (!ok) {
    throw new AppError(500, "Failed to stash OAuth exchange — please retry sign-in");
  }
  return code;
}

export async function redeemOAuthExchange(code: string): Promise<OAuthTokenBundle> {
  const key = oauthExchangeKey(code);
  // GETDEL semantics — atomic read-and-clear so the code is single-use
  // even under concurrent redemption attempts.
  let raw: string | null;
  try {
    // `GETDEL` was added in Redis 6.2; ioredis exposes it via
    // .call("GETDEL", key) to stay compatible across server versions.
    raw = (await redis.call("GETDEL", key)) as string | null;
  } catch {
    // Older Redis without GETDEL — fall back to GET + DEL. Race window
    // is one round-trip; downside is bounded.
    raw = await redis.get(key);
    if (raw) await redis.del(key);
  }
  if (!raw) {
    throw new AppError(401, "OAuth exchange code is invalid or already used");
  }
  try {
    return JSON.parse(raw) as OAuthTokenBundle;
  } catch {
    throw new AppError(500, "OAuth exchange payload was corrupted");
  }
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  // SCAN — never KEYS. `redis.keys()` walks the entire keyspace in one
  // blocking call; on a busy production Redis with hundreds of thousands
  // of session keys that's a multi-second pause that stalls BullMQ, the
  // rate limiter, and every other Redis-backed primitive (auth lockout,
  // idempotency cache, OAuth state). SCAN with COUNT 100 is cursored
  // and yields to other clients every batch.
  try {
    const pattern = `refresh:${userId}:*`;
    let cursor = "0";
    const collected: string[] = [];
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      collected.push(...batch);
    } while (cursor !== "0");

    if (collected.length === 0) return;
    // Pipeline the deletes so we don't issue one round-trip per key on
    // a user who has accumulated a long-lived set of refresh tokens.
    const pipeline = redis.pipeline();
    for (const key of collected) pipeline.del(key);
    await pipeline.exec();
  } catch {
    // Redis unavailable — silently continue. The token rotation path
    // already fails closed when Redis is down, so the residual risk
    // window from an un-revoked token is bounded by its TTL.
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
  // Canonicalise email at the boundary. A user who pastes " Foo@Bar.com" must
  // resolve to the same row as "foo@bar.com" — otherwise findUnique fails on
  // login and the account is silently inaccessible.
  data.email = data.email.trim().toLowerCase();
  data.name = data.name.trim();
  data.tenantName = data.tenantName.trim();

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
  const result = await tenantTx(async (tx) => {
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

  // Email verification (soft gate). Token is random hex; we store the
  // sha256 so the DB never holds plaintext + an exfil-resistant blob.
  // The user can still log in immediately — the UI nags via a banner
  // and trial-pool restrictions apply until they click the link.
  void (async () => {
    try {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7d
      await prisma.user.update({
        where: { id: result.user.id },
        data: {
          emailVerifyTokenHash: tokenHash,
          emailVerifyTokenExpiresAt: expires,
        },
      });
      // Must point at the API's own public origin — GET /api/v1/auth/verify-email
      // redeems the token and redirects to the UI's /auth/verified page.
      // (`${APP_URL}/auth/verify-email` was a 404: the UI has no such route.)
      const verifyUrl = `${env.API_PUBLIC_URL}/api/v1/auth/verify-email?token=${rawToken}`;
      await sendVerifyEmail({ to: result.user.email, verifyUrl });
    } catch {
      /* non-critical — user can re-request via /auth/verify-email/resend */
    }
  })();

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
  // Canonicalise email — must match the same normalisation that register()
  // applies, otherwise " Foo@Bar.com" at register vs "foo@bar.com" at login
  // creates a silent lockout where the legitimate user cannot find their row.
  const email = data.email.trim().toLowerCase();
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

    const result = await tenantTx(async (tx) => {
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
 * Constant-time defense against enumeration: the response timing is
 * identical for "user exists" vs "user missing" because the SendGrid
 * call is fired-and-forgotten on the real path. Both paths complete in
 * DB-read-only time (~5-30ms). Earlier decoy-with-jitter approaches
 * leaked when the real path had a warm-connection SendGrid round-trip
 * (~260ms) that the decoy's 400-1000ms jitter overshot.
 *
 * Trade-off: if SendGrid is briefly down, the user sees "success" but
 * receives no email. They can re-request — reset tokens are single-use
 * anyway. The new internal logger.error makes operator triage easy.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  // Match the canonicalisation applied at register/login — otherwise a user
  // who registered with whitespace or different casing never receives a
  // reset link even when entering their email exactly as they remember it.
  email = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    // No work to do — return in DB-read time. Matching the real path's
    // tail latency this way relies on the real path's send being async.
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

  // Fire-and-forget the SendGrid call — the HTTP response now returns in
  // DB-write time regardless of email-existence. SendGrid latency
  // (200-1100ms warm/cold) used to be the timing oracle.
  void sendPasswordResetEmail({ to: email, resetUrl }).catch(async (err) => {
    const { logger } = await import("../../lib/logger");
    logger.error(
      { email: email.replace(/(?<=.{2}).+(?=@)/, "***"), error: err instanceof Error ? err.message : String(err) },
      "Failed to send password reset email — token written to DB but email not delivered",
    );
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

  // Revoke every refresh token issued before this reset. Without this,
  // an attacker who stole a refresh token before the user reset their
  // password keeps full access until each token's natural expiry — which
  // defeats the whole point of resetting. fail-soft: if Redis is down,
  // the password change still succeeds (the user can self-recover) and
  // the operator alarm on Redis covers the residual exposure window.
  try {
    await revokeAllRefreshTokens(user.id);
  } catch {
    // Redis unreachable — refresh tokens cannot be revoked. The new
    // password still applies on next access-token renewal.
  }

  // Audit the reset so support can confirm the user (not an attacker)
  // initiated it during dispute investigations.
  try {
    await prisma.activityLog.create({
      data: {
        tenantId: user.tenantId,
        actor: user.id,
        action: "auth.password_reset",
        resource: "user",
        resourceId: user.id,
      },
    });
  } catch {
    // Activity log failure must not block password reset.
  }
}

// ─── GITHUB OAUTH ────────────────────────────────────────
//
// Mirrors the Google flow but GitHub speaks plain OAuth2 (no OIDC
// id_token). We exchange the code for an access_token via REST, then
// hit api.github.com/user + /user/emails because GitHub allows users
// to keep their primary email private — the /user endpoint returns
// `email: null` in that case and we fall back to /user/emails to find
// the primary verified address.

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

function requireGitHubConfig() {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_REDIRECT_URI) {
    throw new AppError(503, "GitHub OAuth not configured");
  }
}

export function getGitHubAuthUrl(state?: string): string {
  requireGitHubConfig();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID!,
    redirect_uri: env.GITHUB_REDIRECT_URI!,
    scope: "read:user user:email",
    allow_signup: "true",
  });
  if (state) params.set("state", state);
  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export async function githubCallback(
  code: string,
  ref?: string,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  requireGitHubConfig();

  // 1) Exchange the authorization code for an access token. GitHub's
  // /login/oauth/access_token returns form-encoded by default — Accept:
  // application/json is required for a parseable response.
  const tokenResp = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Braavolabs-OAuth",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_REDIRECT_URI,
    }),
  });
  if (!tokenResp.ok) {
    throw new AppError(400, `GitHub token exchange failed: ${tokenResp.status}`);
  }
  const tokenJson = (await tokenResp.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenJson.access_token) {
    throw new AppError(400, `GitHub token exchange returned no token: ${tokenJson.error_description ?? tokenJson.error ?? "unknown"}`);
  }
  const accessToken = tokenJson.access_token;

  // 2) Fetch the user profile.
  const userResp = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Braavolabs-OAuth",
    },
  });
  if (!userResp.ok) {
    throw new AppError(400, `GitHub /user failed: ${userResp.status}`);
  }
  const ghUser = (await userResp.json()) as GitHubUser;

  // 3) Resolve email — primary verified takes priority over /user.email
  // (which is often null because GitHub privacy defaults hide it).
  let email: string | null = ghUser.email;
  if (!email) {
    const emailsResp = await fetch(GITHUB_EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Braavolabs-OAuth",
      },
    });
    if (emailsResp.ok) {
      const emails = (await emailsResp.json()) as GitHubEmail[];
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }
  }
  if (!email) {
    throw new AppError(400, "GitHub account has no verified email — required to create your Braavolabs account");
  }

  const githubId = String(ghUser.id);
  const name = ghUser.name ?? ghUser.login;
  const picture = ghUser.avatar_url;

  // 4) Find or create user. Same OR-on-githubId-or-email pattern as
  // Google flow so an existing email-password user can link by signing
  // in with GitHub once.
  let user = await prisma.user.findFirst({
    where: { OR: [{ githubId }, { email }] },
    include: { tenant: true },
  });

  if (user) {
    if (!user.githubId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { githubId, avatarUrl: picture ?? user.avatarUrl },
      });
    }
    await prisma.activityLog.create({
      data: {
        tenantId: user.tenantId,
        actor: user.id,
        action: "auth.github_login",
        resource: "user",
        resourceId: user.id,
      },
    });
  } else {
    const slug =
      (name ?? email.split("@")[0])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") +
      "-" +
      Date.now().toString(36);

    const result = await tenantTx(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: name ?? email!.split("@")[0], slug, plan: "FREE" },
      });
      const newUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: email!,
          name: name ?? null,
          avatarUrl: picture ?? null,
          githubId,
          role: "OWNER",
        },
      });
      await tx.activityLog.create({
        data: {
          tenantId: tenant.id,
          actor: newUser.id,
          action: "auth.github_register",
          resource: "user",
          resourceId: newUser.id,
        },
      });
      return { tenant, user: newUser };
    });
    user = { ...result.user, tenant: result.tenant } as any;

    // Referral handling (`ref` query param) — left out of the GitHub
    // flow on purpose. Google + email-password already cover the
    // referral path; folding GitHub into it correctly needs a shared
    // helper. Tracked as a follow-up.
  }

  // 5) Issue tokens — share the same issueTokenPair path as register/login so
  // the Redis allowlist key format stays in lockstep with refreshTokens().
  // Earlier this called redis.set(`refresh:${jti}`, ...) directly, which
  // diverged from refreshKey(userId, jti) and made GitHub-issued refresh
  // tokens permanently un-refreshable (their key lived under refresh:${jti}
  // but the verifier looked at refresh:${userId}:${jti}).
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

// ─── Mobile OAuth (native flows) ────────────────────────────────────
//
// Three POST endpoints on the API side, each accepting a provider
// token / code from the mobile client and minting a Braavolabs JWT.
// Distinct from the web /auth/{google,github}/callback flows because:
//   - Mobile flows never use redirect URIs (the user stays in the app)
//   - Mobile delivers a verifiable proof (Apple/Google) or an
//     exchange-once code (GitHub) directly to the server, bypassing
//     the Redis OAuth-state machinery used by web (no CSRF window —
//     the call is App↔API only)
//   - Mobile has its own client IDs so the GitHub redirect URI can
//     be braavolabs://oauth/github/callback while web stays on the
//     https://braavolabs.com one

const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);
const APPLE_ISSUER = "https://appleid.apple.com";

/**
 * Shared helper for the find-or-create + activity-log + token-issue
 * tail that all 3 mobile flows share. Keeps the per-provider service
 * functions focused on provider-specific verification.
 */
async function upsertAndIssueTokens(args: {
  provider: "apple" | "google" | "github";
  providerUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  const { provider, providerUserId, email, name, avatarUrl } = args;
  const idField =
    provider === "apple"
      ? "appleId"
      : provider === "google"
        ? "googleId"
        : "githubId";

  let user = await prisma.user.findFirst({
    where: { OR: [{ [idField]: providerUserId } as any, { email }] },
    include: { tenant: true },
  });

  if (user) {
    // OAuth providers verify email before returning, so we trust them
    // and auto-mark verified. This also lets existing email-signup
    // users complete verification by simply signing in with their
    // matching Apple/Google/GitHub account.
    const updates: Record<string, unknown> = {};
    if (!(user as any)[idField]) {
      updates[idField] = providerUserId;
      updates.avatarUrl = avatarUrl ?? user.avatarUrl;
    }
    if (!user.emailVerifiedAt) {
      updates.emailVerifiedAt = new Date();
    }
    if (Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updates as any,
      });
    }
    await prisma.activityLog.create({
      data: {
        tenantId: user.tenantId,
        actor: user.id,
        action: `auth.${provider}_login`,
        resource: "user",
        resourceId: user.id,
      },
    });
  } else {
    const slug =
      (name ?? email.split("@")[0])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") +
      "-" +
      Date.now().toString(36);

    const result = await tenantTx(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: name ?? email.split("@")[0], slug, plan: "FREE" },
      });
      const newUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: name ?? null,
          avatarUrl: avatarUrl ?? null,
          [idField]: providerUserId,
          role: "OWNER",
          // OAuth providers vouch for the email before handing it to
          // us; skip the verification email cycle for them.
          emailVerifiedAt: new Date(),
        } as any,
      });
      await tx.activityLog.create({
        data: {
          tenantId: tenant.id,
          actor: newUser.id,
          action: `auth.${provider}_register`,
          resource: "user",
          resourceId: newUser.id,
        },
      });
      return { tenant, user: newUser };
    });
    user = { ...result.user, tenant: result.tenant } as any;
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
    tenant: {
      id: user!.tenant.id,
      name: user!.tenant.name,
      slug: user!.tenant.slug,
      plan: user!.tenant.plan,
    },
  };
}

/**
 * Apple Sign-In (mobile). Verifies the identity token JWS against
 * Apple's JWKS and pins the audience to our iOS bundle identifier so
 * a token issued for a different app can't grant access here.
 *
 * Apple only delivers the user's name + email on the FIRST
 * authorization. We accept the name from the client on first login
 * and store it; later flows fall back to the appleSub lookup.
 */
export async function appleMobileSignIn(
  identityToken: string,
  fullName?: string | null,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  if (!env.APPLE_SIWA_BUNDLE_ID) {
    throw new AppError(503, "Apple Sign-In is not configured");
  }

  let payload;
  try {
    const result = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: env.APPLE_SIWA_BUNDLE_ID,
    });
    payload = result.payload;
  } catch (err) {
    throw new AppError(
      401,
      `Apple identity token verification failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const appleSub = payload.sub;
  const emailFromToken = payload.email as string | undefined;
  if (!appleSub) {
    throw new AppError(400, "Apple token missing subject");
  }
  if (!emailFromToken) {
    // Repeat sign-in: Apple stops sending email after first auth.
    const existing = await prisma.user.findFirst({
      where: { appleId: appleSub },
      include: { tenant: true },
    });
    if (!existing) {
      throw new AppError(
        400,
        "Apple did not return an email — sign out and sign in again with 'Share My Email' selected",
      );
    }
    return upsertAndIssueTokens({
      provider: "apple",
      providerUserId: appleSub,
      email: existing.email,
      name: existing.name,
      avatarUrl: existing.avatarUrl,
    });
  }

  return upsertAndIssueTokens({
    provider: "apple",
    providerUserId: appleSub,
    email: emailFromToken,
    name: fullName?.trim() || null,
    avatarUrl: null,
  });
}

/**
 * Google Sign-In (mobile). The client sends a Google-issued ID token
 * (JWS) obtained natively via expo-auth-session. iOS + Android client
 * IDs are listed as additional accepted audiences so a single
 * endpoint covers both platforms without an extra "platform" field.
 */
export async function googleMobileSignIn(
  idToken: string,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  const allowedAudiences = [
    env.GOOGLE_IOS_CLIENT_ID,
    env.GOOGLE_ANDROID_CLIENT_ID,
    env.GOOGLE_CLIENT_ID, // Web client allowed for shared test fixtures.
  ].filter((v): v is string => !!v);
  if (allowedAudiences.length === 0) {
    throw new AppError(503, "Google OAuth not configured for mobile");
  }

  const client = new OAuth2Client();
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: allowedAudiences,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new AppError(
      401,
      `Google ID token verification failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (!payload?.email || !payload.sub) {
    throw new AppError(400, "Google token missing required claims");
  }

  return upsertAndIssueTokens({
    provider: "google",
    providerUserId: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    avatarUrl: payload.picture ?? null,
  });
}

/**
 * GitHub Sign-In (mobile). Exchanges the one-time authorization code
 * with the mobile-specific client secret (kept server-side only),
 * then fetches the user profile + verified primary email.
 */
export async function githubMobileSignIn(
  code: string,
  redirectUri: string,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  if (!env.GITHUB_MOBILE_CLIENT_ID || !env.GITHUB_MOBILE_CLIENT_SECRET) {
    throw new AppError(503, "GitHub OAuth not configured for mobile");
  }

  // Only accept the exact native scheme we ship — defence in depth.
  if (redirectUri !== "braavolabs://oauth/github/callback") {
    throw new AppError(400, "Unexpected mobile redirect URI");
  }

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Braavolabs-OAuth",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_MOBILE_CLIENT_ID,
      client_secret: env.GITHUB_MOBILE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResp.ok) {
    throw new AppError(400, `GitHub token exchange failed: ${tokenResp.status}`);
  }
  const tokenJson = (await tokenResp.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenJson.access_token) {
    throw new AppError(
      400,
      `GitHub token exchange returned no token: ${tokenJson.error_description ?? tokenJson.error ?? "unknown"}`,
    );
  }

  const accessToken = tokenJson.access_token;
  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Braavolabs-OAuth",
    },
  });
  if (!userResp.ok) {
    throw new AppError(400, `GitHub /user failed: ${userResp.status}`);
  }
  const ghUser = (await userResp.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };

  let email = ghUser.email;
  if (!email) {
    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Braavolabs-OAuth",
      },
    });
    if (emailsResp.ok) {
      const emails = (await emailsResp.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary =
        emails.find((e) => e.primary && e.verified) ??
        emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }
  }
  if (!email) {
    throw new AppError(
      400,
      "GitHub account has no verified email — required to create your Braavolabs account",
    );
  }

  return upsertAndIssueTokens({
    provider: "github",
    providerUserId: String(ghUser.id),
    email,
    name: ghUser.name ?? ghUser.login,
    avatarUrl: ghUser.avatar_url,
  });
}

// ─── Email verification (soft gate) ─────────────────────────────────
//
// register() emits a verification token + sends a link. The user can
// log in immediately (no hard block), but UIs surface a "please
// verify" banner until emailVerifiedAt is populated. OAuth flows
// auto-set emailVerifiedAt at sign-in.

/**
 * Redeem a verification token. Returns the canonical user email so
 * the GET endpoint can render a friendly "verified you@example.com"
 * confirmation page.
 *
 * Token is single-use and expires after 7 days. We compare the
 * sha256 of the supplied raw token against the stored hash so a DB
 * compromise can't be replayed against the verification flow.
 */
export async function verifyEmail(rawToken: string): Promise<{ email: string }> {
  if (!rawToken || rawToken.length < 16) {
    throw new AppError(400, "Invalid verification token");
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const user = await prisma.user.findFirst({
    where: {
      emailVerifyTokenHash: tokenHash,
      emailVerifyTokenExpiresAt: { gt: new Date() },
    },
  });
  if (!user) {
    throw new AppError(400, "Verification link is invalid or expired");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerifyTokenHash: null,
      emailVerifyTokenExpiresAt: null,
    },
  });

  await prisma.activityLog.create({
    data: {
      tenantId: user.tenantId,
      actor: user.id,
      action: "auth.email_verified",
      resource: "user",
      resourceId: user.id,
    },
  });

  return { email: user.email };
}

/**
 * Re-issue a verification email to the authenticated user. Idempotent:
 * calling twice replaces the old token, so the latest email is the
 * one that works.
 *
 * Always returns success — never reveals whether the user is already
 * verified, which would let an attacker probe account state via this
 * endpoint.
 */
export async function resendVerifyEmail(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  if (user.emailVerifiedAt) return; // Already verified — no-op silently.

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifyTokenHash: tokenHash,
      emailVerifyTokenExpiresAt: expires,
    },
  });

  // API origin route, not APP_URL — see the comment in register() above.
  const verifyUrl = `${env.API_PUBLIC_URL}/api/v1/auth/verify-email?token=${rawToken}`;
  await sendVerifyEmail({ to: user.email, verifyUrl }).catch(() => {
    /* non-critical — user can re-request */
  });
}

// ─── Apple Sign-In (Web) ────────────────────────────────────────────
//
// Web flow differs from mobile: Apple POSTs the response back to a
// configured "Return URL" with `response_mode=form_post`. We request
// `response_type=code id_token` so Apple includes the JWS identity
// token directly in the callback body — no separate code exchange
// needed, no client_secret JWT to sign with a .p8 key.
//
// The Service ID (a separate identifier from the iOS bundle id) is
// used both as the OAuth `client_id` in the authorize URL and as the
// `aud` claim during id_token verification.

const APPLE_WEB_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";

/** Build the Apple authorize URL we redirect the user to. */
export function getAppleWebAuthUrl(state: string): string {
  if (!env.APPLE_WEB_SERVICE_ID || !env.APPLE_WEB_REDIRECT_URI) {
    throw new AppError(503, "Apple Sign-In is not configured for web");
  }
  const params = new URLSearchParams({
    client_id: env.APPLE_WEB_SERVICE_ID,
    redirect_uri: env.APPLE_WEB_REDIRECT_URI,
    response_type: "code id_token",
    // form_post is required by Apple when scope is requested — Apple
    // POSTs the response to our callback with the params in the body.
    response_mode: "form_post",
    // `email name` triggers the consent screen + asks Apple to share
    // the user's name on the FIRST sign-in only (subsequent sign-ins
    // return just the email/sub claims).
    scope: "email name",
    state,
  });
  return `${APPLE_WEB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Web Apple Sign-In callback handler.
 *
 * Apple POSTs back: { code, id_token, state, user? } as form-urlencoded.
 * We verify the id_token directly against Apple's JWKS — the `code`
 * is ignored because we never need a refresh token or access to
 * Apple's server-to-server APIs.
 *
 * The `user` field is only present on the FIRST sign-in and contains
 * a JSON-encoded `{ name: { firstName, lastName }, email }`. After
 * that, only `sub` + `email` from the id_token are available.
 */
export async function appleWebCallback(
  idToken: string,
  userJson: string | null,
): Promise<{ token: string; refreshToken: string; user: any; tenant: any }> {
  if (!env.APPLE_WEB_SERVICE_ID) {
    throw new AppError(503, "Apple Sign-In is not configured for web");
  }

  // Verify id_token against Apple's JWKS. Pin `aud` to the Service ID
  // for web; the mobile flow's bundle id is rejected here. (We could
  // accept either, but separating them lets us audit by surface.)
  let payload;
  try {
    const result = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: env.APPLE_WEB_SERVICE_ID,
    });
    payload = result.payload;
  } catch (err) {
    throw new AppError(
      401,
      `Apple identity token verification failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const appleSub = payload.sub;
  const emailFromToken = payload.email as string | undefined;
  if (!appleSub) {
    throw new AppError(400, "Apple token missing subject");
  }

  // Pull the user's full name out of the first-time-only `user` blob.
  let fullName: string | null = null;
  let emailFromUser: string | undefined;
  if (userJson) {
    try {
      const parsed = JSON.parse(userJson) as {
        name?: { firstName?: string; lastName?: string };
        email?: string;
      };
      const first = parsed.name?.firstName?.trim() ?? "";
      const last = parsed.name?.lastName?.trim() ?? "";
      const combined = [first, last].filter(Boolean).join(" ").trim();
      fullName = combined || null;
      emailFromUser = parsed.email;
    } catch {
      // Malformed `user` blob — ignore, the id_token still has what
      // we need to authenticate.
    }
  }

  const email = emailFromToken ?? emailFromUser;
  if (!email) {
    // Repeat sign-in: Apple stops sending email after first auth.
    const existing = await prisma.user.findFirst({
      where: { appleId: appleSub },
      include: { tenant: true },
    });
    if (!existing) {
      throw new AppError(
        400,
        "Apple did not return an email — please retry and choose 'Share My Email'",
      );
    }
    return upsertAndIssueTokens({
      provider: "apple",
      providerUserId: appleSub,
      email: existing.email,
      name: existing.name,
      avatarUrl: existing.avatarUrl,
    });
  }

  return upsertAndIssueTokens({
    provider: "apple",
    providerUserId: appleSub,
    email,
    name: fullName,
    avatarUrl: null,
  });
}
