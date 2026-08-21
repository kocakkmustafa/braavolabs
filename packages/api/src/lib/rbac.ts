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
  // The SPEND CAP, not just the act of paying. A review caught that shipping
  // "money is OWNER-only" while leaving this open made the claim false: any
  // member could raise monthlyBudgetUsd to the schema max, or null it and
  // thereby disable the cost-anomaly stop that rule #8 depends on.
  "billing:budget": "OWNER",
  // Tenant-wide credential control, and keyed on tenantId rather than userId:
  // whoever writes this replaces the BYOK apiKey AND baseUrl for every user in
  // the tenant, which points every LLM call at an endpoint of their choosing
  // and exfiltrates prompts and outputs. Strictly more damaging than
  // company:delete, which is a soft archive.
  "settings:ai-config": "ADMIN",
  "governance:hard-stop": "ADMIN",
  "sso:configure": "ADMIN",

  // Bulk read of the tenant's audit trail — every actor id, every ip, every
  // action. Sensitive, but neither irreversible nor money, so ADMIN by the
  // reversibility principle above. In the roadmap's six-role vocabulary this
  // is the `auditor` tier's job; with three roles ADMIN is the closest
  // REACHABLE tier that is not "everyone", and putting it at OWNER would make
  // the only person who can review denials the same person most likely to be
  // the subject of them.
  "audit:export": "ADMIN",

  // ── approval:decide is deliberately held at MEMBER ────────────────────────
  //
  // It belongs at ADMIN on the reversibility principle, and it was set there.
  // A review found that would break the product the first time an org enables
  // SSO: sso.router.ts provisions every JIT user as MEMBER, there is NO
  // member-management endpoint anywhere in the API, and approvals are a core
  // workflow (rule #3 makes them the gate on every money-touching action). So
  // ADMIN would be an unreachable tier, and the only remedy would be a manual
  // UPDATE against production.
  //
  // Holding at MEMBER preserves today's behaviour rather than shipping a matrix
  // whose ADMIN tier nobody can reach. Raising it requires a role-management
  // surface first — a founder decision, recorded in the evidence ledger.
  //
  // ⚠️ Consequence worth stating: MEMBER is the FLOOR of ROLE_RANK, so
  // `roleCan` is unconditionally true for this action and the gate can never
  // refuse. It is one of twelve declared actions and one of the twelve gated
  // routes, but only ELEVEN can ever produce a denial — so "twelve gated
  // routes, denials recorded" must not be read as twelve.
  "approval:decide": "MEMBER",
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
