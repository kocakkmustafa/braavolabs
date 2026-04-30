/**
 * Pipeline export DRM endpoints. The runtime SDK (separate package,
 * shipped to user machines alongside the encrypted bundle) is the
 * primary consumer.
 *
 *   POST /api/v1/license/download        — bind machine + return encrypted bundle
 *   POST /api/v1/license/verify          — runtime self-check (no DB write)
 *   POST /api/v1/license/change-machine  — explicit machine swap (consumes monthly quota)
 *   GET  /api/v1/license/status          — dashboard view ("bound on Apr 7, 1 swap left")
 *
 * All endpoints are authMiddleware-gated EXCEPT the runtime-side verify
 * call doesn't require a user JWT — it validates the LICENSE token. We
 * keep authMiddleware on /verify too because in practice the SDK still
 * has the user's token (the same token that downloaded the file), and
 * dropping it here would let an attacker probe license validity without
 * any rate limit. /verify with auth → still cheap, still safe.
 *
 * Rate limits live one tier above (express-rate-limit on the api router).
 * License-specific limits would go here if abuse appears.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import {
  bindMachine,
  encryptForMachine,
  verifyLicenseFreshness,
  hashFingerprint,
} from "../../services/pipeline-license";

export const licenseRouter = Router();
licenseRouter.use(authMiddleware);

// Reject early when the operator hasn't configured DRM. Returning 503
// (not 500) signals "this feature is intentionally off for this
// deployment" — clients can render a "self-hosted: DRM disabled" banner
// instead of treating it as a server bug.
function ensureDrmEnabled() {
  if (!process.env.LICENSE_JWT_SECRET) {
    throw new AppError(
      503,
      "Pipeline DRM is disabled on this deployment (LICENSE_JWT_SECRET unset).",
    );
  }
}

// Fingerprint shape: a free-form string (the runtime computes it from
// CPU id + OS + hostname + MAC). We don't try to validate the format
// — different OSes produce wildly different shapes — but we cap the
// length so a malicious client can't blow up our SHA-256 with a 50MB
// payload. 1024 chars is generous for any sane fingerprint algo.
const fingerprintSchema = z.object({
  fingerprint: z.string().min(8).max(1024),
});

// ────────────────────────────────────────────────────────────────
// POST /license/download — encrypt a pipeline bundle for a machine
//
// Body: { fingerprint: string, pipelineId?: string }
// Returns: EncryptedBundle JSON
//
// Behavior:
//   • If the tenant has no binding yet → bind to this fingerprint.
//   • If the binding matches → success.
//   • If a different fingerprint shows up → 409 with
//     { reason: "different_machine" }, telling the SDK to redirect the
//     user through /change-machine.
//
// The plaintext we encrypt is a JSON bundle of the pipeline + agents +
// tools + config. Without `pipelineId`, we encrypt all of the tenant's
// pipelines (rare; mostly used for "export everything" tooling).
// ────────────────────────────────────────────────────────────────
licenseRouter.post("/download", async (req, res, next) => {
  try {
    ensureDrmEnabled();

    const body = fingerprintSchema
      .extend({ pipelineId: z.string().min(1).optional() })
      .parse(req.body);

    const tenantId = req.auth!.tenantId;

    const bind = await bindMachine(tenantId, body.fingerprint, { rebind: false });
    if (!bind.ok) {
      // 409 Conflict — the same machine semantically conflicts with the
      // already-bound one. The SDK uses this status to trigger the
      // change-machine prompt.
      throw new AppError(409, bind.message, { reason: bind.reason });
    }

    // Build the plaintext bundle. Pipeline-scoped or whole-tenant
    // depending on body.pipelineId.
    const plaintext = await buildPlaintextBundle(tenantId, body.pipelineId);
    if (!plaintext) {
      throw new AppError(404, "No exportable pipeline found for the given pipelineId");
    }

    const bundle = encryptForMachine(plaintext, body.fingerprint, {
      tenantId,
      pipelineId: body.pipelineId,
    });

    // Log the download for audit + Stripe usage metering hooks downstream.
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "license.download",
        resource: "pipeline",
        resourceId: body.pipelineId ?? "all",
        details: {
          fingerprintHash: bind.fingerprintHash.slice(0, 16) + "…",
          rebound: bind.rebound,
          remainingChanges: bind.remainingChanges,
        },
      },
    });

    res.json(bundle);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
// POST /license/verify — runtime self-check
//
// Body: { license: string, fingerprint: string }
// Returns: { ok: true, expiresAt } OR { ok: false, reason, message }
//
// Used when:
//   • The runtime starts up and wants to confirm the cached license is
//     still valid before reading the encrypted bundle.
//   • The runtime detects a clock skew or expiry near-miss and wants the
//     server-side answer.
//
// We never return the plaintext or AES key here. The runtime decrypts
// locally; this endpoint is just a yes/no with reasoning.
// ────────────────────────────────────────────────────────────────
licenseRouter.post("/verify", async (req, res, next) => {
  try {
    ensureDrmEnabled();

    const schema = fingerprintSchema.extend({ license: z.string().min(20) });
    const body = schema.parse(req.body);

    const result = await verifyLicenseFreshness(body.license, body.fingerprint);

    // Always return 200 — the SDK reads the `ok` field. Returning 4xx
    // here would force the client to handle both error paths (HTTP-level
    // and JSON-level), which has caused bugs in similar systems before.
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
// POST /license/change-machine — bind a NEW fingerprint, consuming quota
//
// Body: { fingerprint: string }
// Returns: { ok: true, remainingChanges } OR 4xx with reason
//
// This is the legitimate "I bought a new laptop" flow. The monthly quota
// (LICENSE_MACHINE_CHANGES_PER_MONTH, default 1) caps how often this
// can be called per calendar month (UTC).
// ────────────────────────────────────────────────────────────────
licenseRouter.post("/change-machine", async (req, res, next) => {
  try {
    ensureDrmEnabled();
    const body = fingerprintSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const bind = await bindMachine(tenantId, body.fingerprint, { rebind: true });
    if (!bind.ok) {
      // 429 Too Many Requests — quota exhausted.
      // 400 Bad Request — DRM disabled / bad input (already caught above).
      const status = bind.reason === "quota_exhausted" ? 429 : 400;
      throw new AppError(status, bind.message, { reason: bind.reason });
    }

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "license.change_machine",
        resource: "pipeline_license",
        resourceId: tenantId,
        details: {
          fingerprintHash: bind.fingerprintHash.slice(0, 16) + "…",
          remainingChanges: bind.remainingChanges,
        },
      },
    });

    logger.info(
      { tenantId, remainingChanges: bind.remainingChanges },
      "License rebound via /change-machine",
    );

    res.json({
      ok: true,
      remainingChanges: bind.remainingChanges,
      message:
        bind.remainingChanges > 0
          ? `Machine rebound. You have ${bind.remainingChanges} machine ${
              bind.remainingChanges === 1 ? "change" : "changes"
            } left this month.`
          : "Machine rebound. No more machine changes available until next month.",
    });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /license/status — dashboard view of the current binding
//
// No body. Returns:
//   {
//     enabled: boolean,            // false → DRM disabled on this server
//     bound: boolean,              // false → first download will bind
//     fingerprintPreview: string?, // first 12 chars of the hash, never the raw
//     boundAt: ISO string?,
//     monthlyChangesUsed: number,
//     monthlyChangesAllowed: number,
//     monthlyChangesRemaining: number,
//   }
// ────────────────────────────────────────────────────────────────
licenseRouter.get("/status", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const enabled = !!process.env.LICENSE_JWT_SECRET;

    if (!enabled) {
      res.json({
        enabled: false,
        bound: false,
        monthlyChangesUsed: 0,
        monthlyChangesAllowed: 0,
        monthlyChangesRemaining: 0,
      });
      return;
    }

    const row = await prisma.pipelineLicense.findUnique({ where: { tenantId } });
    const period = new Date().toISOString().slice(0, 7);
    const usedThisPeriod =
      row && row.monthlyChangePeriod === period ? row.monthlyMachineChangesUsed : 0;
    const allowed = env.LICENSE_MACHINE_CHANGES_PER_MONTH;

    res.json({
      enabled: true,
      bound: !!row?.deviceFingerprint,
      fingerprintPreview: row?.deviceFingerprint?.slice(0, 12) ?? null,
      boundAt: row?.lastBoundAt?.toISOString() ?? null,
      monthlyChangesUsed: usedThisPeriod,
      monthlyChangesAllowed: allowed,
      monthlyChangesRemaining: Math.max(0, allowed - usedThisPeriod),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ───────────────────────────────────────────────────

/** Build the plaintext JSON bundle that gets encrypted. Returns null
 * when no exportable rows exist. */
async function buildPlaintextBundle(
  tenantId: string,
  pipelineId?: string,
): Promise<string | null> {
  if (pipelineId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, company: { tenantId } },
      include: {
        company: { include: { agents: true } },
      },
    });
    if (!pipeline) return null;

    return JSON.stringify(
      {
        version: 1,
        kind: "single-pipeline",
        exportedAt: new Date().toISOString(),
        tenantId,
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          steps: pipeline.steps,
          config: pipeline.config,
        },
        company: {
          id: pipeline.company.id,
          name: pipeline.company.name,
          slug: pipeline.company.slug,
          primitives: pipeline.company.primitives,
          agents: pipeline.company.agents.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            systemPrompt: a.systemPrompt,
            tools: a.tools,
            model: a.model,
            maxTokens: a.maxTokens,
          })),
        },
      },
      null,
      2,
    );
  }

  // No pipelineId — bundle the whole tenant. Used by enterprise hand-off.
  const companies = await prisma.company.findMany({
    where: { tenantId },
    include: {
      agents: true,
      pipelines: true,
    },
  });
  if (companies.length === 0) return null;
  return JSON.stringify(
    {
      version: 1,
      kind: "tenant-bundle",
      exportedAt: new Date().toISOString(),
      tenantId,
      companies,
    },
    null,
    2,
  );
}

// Mark hashFingerprint as exported so the runtime SDK package can import
// the same logic for parity if shipped from the same monorepo. Today the
// SDK lives elsewhere; reserving the export keeps the surface stable.
export { hashFingerprint };
