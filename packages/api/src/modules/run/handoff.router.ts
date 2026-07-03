/**
 * Tenant-wide handoff LIST router (E3/T5, plan §2.6). The per-run history lives
 * on the run router (`GET /runs/:id/handoffs`); this surface answers "which of
 * my runs are waiting for a takeover?" across the whole tenant — the data
 * source for `braavo handoffs [--open]` (CLI) and any cross-run panel.
 *
 * Mounted at /api/v1/handoffs. Read-only, tenant-scoped through the ledger's
 * FK back to the run's company. checkpoint is omitted from the list payload
 * (large; the takeover leg reads it server-side).
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import type { HandoffStatus } from "@prisma/client";

export const handoffRouter = Router();
handoffRouter.use(authMiddleware);

const VALID_STATUSES: HandoffStatus[] = ["OPEN", "CLAIMED", "COMPLETED", "FAILED", "CANCELLED"];

// GET /api/v1/handoffs?status=OPEN — tenant-wide ledger list, newest first.
// `status` optional; when omitted, returns every ledger for the tenant. An
// invalid status is ignored (returns all) rather than 400 — the CLI passes a
// convenience flag, not a validated enum.
handoffRouter.get("/", async (req, res, next) => {
  try {
    const rawStatus = String(req.query.status ?? "").trim().toUpperCase();
    const status = VALID_STATUSES.includes(rawStatus as HandoffStatus)
      ? (rawStatus as HandoffStatus)
      : undefined;

    const ledgers = await prisma.handoffLedger.findMany({
      where: {
        // Tenant scope: the ledger carries tenantId directly, but we double-
        // bind through the run's company so a stale tenantId can't leak rows.
        tenantId: req.auth!.tenantId,
        run: { pipeline: { company: { tenantId: req.auth!.tenantId } } },
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, runId: true, stepIndex: true, status: true, reason: true,
        fromProvider: true, fromModel: true, toProvider: true, toModel: true,
        contextSummary: true, createdBy: true, claimedBy: true,
        createdAt: true, claimedAt: true, completedAt: true,
      },
    });
    res.json({ handoffs: ledgers });
  } catch (err) { next(err); }
});
