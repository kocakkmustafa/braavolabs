import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { prisma } from "../../lib/db";
import { isJobStateDualWriteEnabled } from "../run/transition";
import { isExactActionApprovalEnabled } from "../approval/exact-action";
import { isStepApprovalGateEnabled } from "../pipeline/step-approval";

// BRA-OPS-02: salt-okur yönetici ucu. Sunucu tarafı bayrakların açık/kapalı
// durumunu döner. Rollout bilgisi sızmasın diye herkese açık /health'e KONMAZ;
// yalnız kimliği doğrulanmış platform yöneticisi (MARKETPLACE_ADMIN_EMAILS,
// bench/marketplace ile aynı kalıp) görür. Yönetici listesi boşsa kimse
// yönetici sayılmaz (fail-closed). NEXT_PUBLIC_UX_* bayrakları UI derlemesine
// gömülüdür, API göremez; bu uç onları raporlamaz.

export const opsRouter: Router = Router();

export function isPlatformAdminEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email) return false;
  const admins = (env.MARKETPLACE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

export function serverFlagState(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; enabled: boolean }> {
  return [
    { name: "JOB_STATE_DUAL_WRITE", enabled: isJobStateDualWriteEnabled(env) },
    { name: "EXACT_ACTION_APPROVAL", enabled: isExactActionApprovalEnabled(env) },
    { name: "STEP_APPROVAL_GATE", enabled: isStepApprovalGateEnabled(env) },
  ];
}

opsRouter.get("/flags", authMiddleware, async (req, res, next) => {
  try {
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true, emailVerifiedAt: true } });
    // Fail-closed: e-posta listede olsa bile doğrulanmamış hesap yönetici sayılmaz.
    if (!me?.emailVerifiedAt || !isPlatformAdminEmail(me.email)) {
      throw new AppError(403, "Restricted to platform admins");
    }
    res.set("Cache-Control", "no-store");
    res.json({ flags: serverFlagState(), generatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});
