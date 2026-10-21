import jwt from "jsonwebtoken";
import type { Request } from "express";
import { env } from "../config/env";
import { runWithTenant } from "./tenant-context";
import { retirePushSession, type PushActor } from "./pushOwnership";

export const isPushSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Revocation-only proof. An expired access token cannot refresh/borrow the next
 * user's bearer; a captured, still-valid refresh token can retire its own SID.
 * Cookie credentials are deliberately not read on this bearer/body endpoint.
 */
export async function cleanupPushSession(req: Pick<Request, "headers" | "body">): Promise<void> {
  const access = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const refresh = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : null;
  for (const [token, wantsRefresh] of [[access, false], [refresh, true]] as const) {
    if (!token) continue;
    let payload: Record<string, unknown>;
    try { payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>; }
    catch { continue; }
    if (!payload || typeof payload !== "object" ||
        (wantsRefresh ? payload.typ !== "refresh" : payload.typ === "refresh") ||
        typeof payload.userId !== "string" || !payload.userId.trim() ||
        typeof payload.tenantId !== "string" || !payload.tenantId.trim() || !isPushSessionId(payload.pushSessionId)) continue;
    const actor: PushActor = { userId: payload.userId, tenantId: payload.tenantId, pushSessionId: payload.pushSessionId };
    await runWithTenant(actor.tenantId, () => retirePushSession(actor));
    return;
  }
  // Identical response for missing/invalid proof, absent or already-retired SID.
}
