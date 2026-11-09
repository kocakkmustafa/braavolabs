import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { transitionRun, isJobStateDualWriteEnabled } from "./transition";
import type { JobState } from "./job-state";
import { beatRun, forgetBeat } from "./heartbeat";

/**
 * BRA-P0-02c-4/-5: the graph and hierarchical runners' lifecycle writer. Shared (02c-5). Every RUNNING/FAILED/
 * COMPLETED write goes through `transitionRun` (compare-and-set), so a run that
 * was cancelled/paused from outside is never overwritten. Returns true only
 * when THIS call moved the run; the caller then (and only then) runs side
 * effects (activity row, event, metrics). On false the runner exits cleanly.
 *
 * Flag OFF: `legacyUnchecked` keeps the old unconditional `status` write (no
 * graph check); only a lost status CAS (a concurrent write between our read
 * and write) stops the runner. Flag ON: the graph is enforced; a lost CAS is
 * re-read ONCE so the right edge is chosen for the fresh state. A paused
 * (PAUSED/NEEDS_APPROVAL) run has no edge to COMPLETED, so it stays as the
 * operator left it: the finished steps are persisted and /resume re-enters the
 * runner, which restores them and finalizes (ADR-0001 (a)).
 */
export async function writeLifecycle(
  runId: string,
  tenantId: string,
  to: JobState,
  extra: Parameters<typeof transitionRun>[3]["extra"],
): Promise<boolean> {
  const dual = isJobStateDualWriteEnabled();
  for (let attempt = 0; attempt < (dual ? 2 : 1); attempt++) {
    const o = await transitionRun(prisma, runId, to, { tenantId, extra, legacyUnchecked: true });
    if (o.ok) {
      // BRA-P0-04d: alımda taze kalp atışı (kısıtsız); terminal/duraklatmada hafızayı boşalt.
      if (to === "RUNNING") await beatRun(runId, tenantId, { force: true });
      else forgetBeat(runId);
      // RUNNING→RUNNING is a same-state noop in graph mode and is fine (re-pickup).
      // A noop FAILED/COMPLETED means someone else already finished it: no side effects.
      return !o.noop || to === "RUNNING";
    }
    if (o.reason !== "lost_race") {
      logger.info({ runId, to, reason: o.reason, from: "from" in o ? o.from : undefined }, "Runner lifecycle write skipped — run is no longer ours");
      return false;
    }
  }
  logger.info({ runId, to }, "Runner lifecycle write lost the race — exiting without side effects");
  return false;
}
