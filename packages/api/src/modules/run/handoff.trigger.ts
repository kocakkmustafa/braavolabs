/**
 * Automatic handoff trigger (E3 §2.3b / §2.5 — B3/B4a). The executor's catch
 * calls this ONLY after isHandoffTriggerEligible(err) confirms a marked,
 * trustworthy provider chain-exhaustion (ProviderExhaustedError with a FAILOVER
 * classification, or a TRANSIENT carrying a real HTTP status). Generic failures
 * never reach here.
 *
 * Two sub-scenarios (B4a):
 *   (a) NO viable alternative provider → open the ledger OPEN, create NO
 *       Approval. The run stays FAILED; the operator picks a provider from
 *       web/CLI (a binary mobile APPROVE can't carry a provider param, so a
 *       parameterless HANDOFF approval would be a dead end).
 *   (b) A viable alternative exists → open the ledger + a HANDOFF Approval
 *       carrying {handoffId, suggestedProvider, suggestedModel}. APPROVE claims
 *       the handoff (T5 approval decide handler).
 *
 * The caller (executor) wraps THIS whole call in a try/catch that swallows —
 * so a failure here never blocks the step's FAILED marking (B6.2). The internal
 * try/catch here is defence-in-depth for the Approval write specifically.
 */

import type { HandoffReason } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { ProviderExhaustedError, isHandoffTriggerEligible } from "../../services/provider-chain";
import { createHandoff, resolveViableHandoffTarget } from "./handoff.service";

/** Map the marker's classification onto the ledger reason enum (§2.1). */
function reasonForMarker(err: ProviderExhaustedError): HandoffReason {
  return err.classification === "FAILOVER" ? "PROVIDER_FAILOVER" : "PROVIDER_EXHAUSTED";
}

/**
 * Open an automatic handoff for a run whose provider chain was exhausted. Best-
 * effort throughout; the executor swallows any throw. Returns the ledger id on
 * success (mostly for tests), null when nothing was opened.
 */
export async function maybeOpenAutoHandoff(
  runId: string,
  err: unknown,
): Promise<string | null> {
  // Guard is enforced here too (defence-in-depth): the executor already gates
  // on isHandoffTriggerEligible, but this function is public — a FATAL marker,
  // a default-TRANSIENT guess, or any non-marker error must NEVER open a
  // ledger regardless of the call site (B3).
  if (!isHandoffTriggerEligible(err)) return null;

  const reason = reasonForMarker(err);
  const ledger = await createHandoff({
    runId,
    reason,
    createdBy: "system",
    fromProvider: err.provider,
    fromModel: err.model,
    // The chain is exhausted and the loop is DEAD — freeze the checkpoint from
    // run_steps.transcript now rather than waiting for a live loop that will
    // never run again (§2.3b). Even if the run is still momentarily RUNNING
    // (the runner finalizes it to FAILED after executeStep returns), the
    // takeover must not stall behind the 120s stale timer.
    freezeFromTranscript: true,
  });

  // B4a: only create a HANDOFF Approval when a VIABLE target resolves — a
  // configured, untripped BYOK link on a DIFFERENT provider than the one that
  // died. No viable target → ledger stays OPEN, NO approval; the operator
  // chooses from web/CLI.
  const viable = await resolveViableHandoffTarget(ledger.tenantId, err.provider);
  if (!viable) {
    logger.info(
      { runId, handoffId: ledger.id, fromProvider: err.provider },
      "auto handoff opened WITHOUT approval — no viable alternative provider (operator must pick from web/CLI)",
    );
    return ledger.id;
  }

  try {
    const approval = await prisma.approval.create({
      data: {
        runId,
        type: "HANDOFF",
        status: "PENDING",
        description: `Provider ${err.provider} exhausted the chain. Continue this run with ${viable.provider}?`,
        metadata: {
          handoffId: ledger.id,
          suggestedProvider: viable.provider,
          suggestedModel: viable.model,
        },
      },
    });
    // Surface on the run stream so the pending HANDOFF approval shows in the
    // same queue the mobile app already renders (zero mobile code). Best-effort.
    const { publishRunEvent } = await import("../../lib/runEvents");
    await publishRunEvent(runId, {
      type: "APPROVAL_REQUESTED",
      approvalId: approval.id,
      description: `Continue this run with ${viable.provider}?`,
    });
  } catch (approvalErr) {
    // The ledger is already OPEN and claimable from web/CLI even without the
    // approval — swallow so a failed approval write never re-throws into the
    // executor and re-runs the step (B6.2).
    logger.warn(
      { runId, handoffId: ledger.id, err: (approvalErr as Error).message },
      "HANDOFF approval create failed (non-fatal — ledger stays OPEN, claimable from web/CLI)",
    );
  }

  return ledger.id;
}
