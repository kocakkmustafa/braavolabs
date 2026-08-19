/**
 * Role matrix (BR-P1-005, roadmap §7.3: "RBAC: owner, admin, operator,
 * approver, auditor, billing" + "Least privilege API matrix").
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `requireRole` exists in middleware/auth.ts and is applied by ZERO routes.
 *   - Exactly two inline role checks exist in the entire API, both in
 *     sso.router.ts.
 *   - Therefore company deletion, billing checkout, the billing portal,
 *     governance hard-stop and approval decisions are all reachable by ANY
 *     authenticated user, MEMBER included.
 *
 * ROLE VOCABULARY — 3 today, 6 in the roadmap
 *
 * The Prisma enum is OWNER | ADMIN | MEMBER, and that is what the JWT carries.
 * The roadmap names six (owner, admin, operator, approver, auditor, billing).
 * Inventing the other three here would be fiction: nothing issues them, so a
 * matrix keyed on them would enforce nothing while looking complete.
 *
 * So this maps the roadmap's INTENT onto the roles that actually exist, and the
 * expansion to six is a schema migration plus a decision about who gets which
 * role — recorded as a founder gate rather than assumed.
 *
 * DESIGN: rank-based, and default-deny on BOTH inputs. An unknown role has no
 * privileges, and an undeclared action is refused rather than permitted —
 * because a typo in an action name must not become an authorisation bypass.
 */

export const ROLE_RANK = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
} as const;

export type AppRole = keyof typeof ROLE_RANK;

/**
 * Minimum role per privileged action.
 *
 * The split is by REVERSIBILITY, not by seniority for its own sake:
 *   - OWNER-only: moving money and destroying a tenant's data. Neither can be
 *     undone by the person who did it.
 *   - ADMIN+: operational controls that are reversible or already audited
 *     (stopping a run, deciding an approval, configuring SSO).
 */
export const PRIVILEGED_ACTIONS = {
  "company:delete": "OWNER",
  "billing:checkout": "OWNER",
  "billing:portal": "OWNER",
  "governance:hard-stop": "ADMIN",
  "approval:decide": "ADMIN",
  "sso:configure": "ADMIN",
} as const satisfies Record<string, AppRole>;

export type PrivilegedAction = keyof typeof PRIVILEGED_ACTIONS;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}
deepFreeze(ROLE_RANK);
deepFreeze(PRIVILEGED_ACTIONS);

/**
 * May `role` perform `action`?
 *
 * Fail-closed on both axes. hasOwnProperty rather than a bare index on each
 * lookup: `PRIVILEGED_ACTIONS["constructor"]` would otherwise resolve through
 * the prototype chain and hand back a truthy value — the same defect an
 * independent review proved against the product-event allowlist.
 */
export function roleCan(role: AppRole, action: PrivilegedAction): boolean {
  if (typeof role !== "string" || !Object.prototype.hasOwnProperty.call(ROLE_RANK, role)) {
    return false;
  }
  if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(PRIVILEGED_ACTIONS, action)) {
    return false;
  }
  return ROLE_RANK[role] >= ROLE_RANK[PRIVILEGED_ACTIONS[action]];
}
