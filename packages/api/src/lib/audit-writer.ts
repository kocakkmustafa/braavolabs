/**
 * The one place a refusal BY THE ROLE MATRIX becomes a row (BR-P1-005 slice B).
 *
 * SCOPE, stated up front because the shorter claim is false and would be
 * quoted: refusals by other mechanisms are NOT covered. `assertAdmin`
 * (marketplace, 2 routes) is an email allowlist whose refusals write nothing;
 * 122 mutation routes have no gate to refuse with at all; and governance and
 * quota refusals already write their own rows under their own action names
 * (`governance.*_stop`, `*.limit_reached`, `run.rejected_step_count`,
 * `approval.expired`). The claim is "refusals by the role matrix are
 * recorded", not "all refusals are recorded".
 *
 * Slice A gave ActivityLog `result` and `policy` and wrote exactly one row —
 * a SUCCESSFUL export. All 130 other writers are on success paths too, so
 * the trail records what people were permitted to do and is silent about what
 * they were refused, including a refused audit export.
 *
 * That is backwards. A permission gate produces its most valuable evidence at
 * the moment it FIRES, and in today's trail "nobody has ever been refused
 * anything" is indistinguishable from "we never wrote it down".
 */
import { prisma } from "./db";
import { logger } from "./logger";
import type { PrivilegedAction } from "./rbac";

/** Bound on any caller-influenced value that reaches the trail. */
const MAX_RECORDED = 64;

/**
 * Record the value, or record nothing — never a prefix.
 *
 * Truncating would put a plausible-looking WRONG identifier into an audit
 * record, which is the same hazard the no-backfill decision rejected: a
 * manufactured answer is worse than an honest absence. 64 is comfortable
 * headroom over every id this codebase mints (cuid 25, cuid2 24, uuid 36),
 * so exceeding it means the value is not an id at all.
 */
function bounded(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  return v.length > MAX_RECORDED ? null : v;
}

/**
 * Record that `action` was refused for `actor`.
 *
 * FIRE AND FORGET, ON PURPOSE, in both directions:
 *
 *   - the refusal is not delayed by a database write, and
 *   - a failed write can never fail the request OPEN. If producing the
 *     evidence could change the decision, the log would become a bypass:
 *     take the database down, get past the gate.
 *
 * A write that fails is logged at error level rather than swallowed, because
 * "the audit write is broken" is itself an operational fact someone needs.
 *
 * ⚠️ UNBOUNDED BY DESIGN — open item, not an oversight. A single MEMBER with
 * one token was measured writing 150 rows in 111ms (~1,351 rows/sec, ~4.8M
 * rows/hour), and of the 11 gates that can actually deny, none of the routes
 * carry a rate limiter. Against the roadmap's 7-day retention tier that does
 * not merely make noise: it pushes every real event out of the window, so an
 * attacker can erase the trail USING the logger built to protect it. Flooding
 * destroys existing evidence, where suppression only loses hypothetical
 * future evidence — the flood is the worse of the two.
 *
 * The fix is collapse, which is NOT suppression: always write the first
 * denial in a window immediately, count the rest keyed on
 * (tenantId, actor, policy), and emit one row carrying a server-derived
 * count on roll. A derived integer in `details` does not reopen the
 * caller-controlled-payload problem. If Redis is unavailable, fall back to
 * writing every row. Not implemented here; tracked against §7.4 retention.
 */
export function recordDenial(params: {
  tenantId: string;
  actor: string;
  action: PrivilegedAction;
  resourceId?: unknown;
  ip?: unknown;
}): void {
  const { tenantId, actor, action } = params;

  // `company:delete` -> resource `company`. Derived, never caller-supplied.
  const resource = action.split(":")[0] ?? "unknown";

  // Wrapped, because `void p.catch(h)` attaches the handler AFTER create()
  // returns: a SYNCHRONOUS throw never reaches it and would replace the
  // deliberate 403 with a 500 carrying an internal error string. Prisma's
  // delegates return lazy promises so that is unlikely today — but this
  // helper documents an invariant, and an invariant that holds by luck is
  // not one. The inner guard exists because `void p.catch(h)` returns a
  // promise nobody listens to: if `h` itself throws, that rejection is
  // unhandled, and Node 22 exits on unhandled rejections.
  const onFailure = (err: unknown): void => {
    try {
      logger.error({ err, tenantId, action }, "failed to record an authorisation denial");
    } catch {
      /* the evidence path must never throw into the request */
    }
  };

  try {
    void prisma.activityLog
    .create({
      data: {
        tenantId,
        actor,
        // The verb is uniform so a reviewer can ask "show me every refusal"
        // without knowing the action vocabulary; WHICH rule refused lives in
        // `policy`, which is the field the roadmap names for it.
        action: "authorization.denied",
        resource,
        resourceId: bounded(params.resourceId),
        result: "denied",
        policy: action,
        ip: bounded(params.ip),
        // Deliberately NO details blob. The 403 body names the action and
        // never the required role, because "you need OWNER" enumerates the
        // privilege model for the caller; recording that role here would
        // undo it at the other end, since the export exists to be read.
        // It is also the field an unbounded caller value would reach.
        //
        // Prisma still fills it with its `@default("{}")`, so the row an
        // auditor reads carries an empty object rather than no key at all.
        // The point above stands — nothing caller-controlled goes in — but
        // "no details blob whatsoever" would be false about the stored row.
      },
    })
    .catch(onFailure);
  } catch (err) {
    onFailure(err);
  }
}
