import { describe, it, expect } from "vitest";
import { PRIVILEGED_ACTIONS, roleCan, ROLE_RANK, type AppRole } from "../rbac";

/**
 * BR-P1-005 — role matrix (roadmap §7.3: "RBAC: owner, admin, operator,
 * approver, auditor, billing" + "Least privilege API matrix").
 *
 * Measured before writing any of this:
 *   - `requireRole` exists in middleware/auth.ts and is used by ZERO routes.
 *   - Exactly 2 inline role checks exist in the whole API, both in sso.router.
 *   - So company delete, billing checkout, billing portal, governance
 *     hard-stop and approval decide are reachable by ANY authenticated user,
 *     MEMBER included.
 *
 * The schema has 3 roles (OWNER/ADMIN/MEMBER), the roadmap names 6. Rather
 * than pretend the other 3 exist, this maps the roadmap's INTENT onto the
 * roles that are actually issued in JWTs today, and the expansion is a
 * separate migration + founder decision (recorded in the ledger).
 */
describe("the role matrix is total and ordered", () => {
  it("ranks every role that can appear in a JWT today", () => {
    expect(Object.keys(ROLE_RANK).sort()).toEqual(["ADMIN", "MEMBER", "OWNER"]);
  });

  it("orders OWNER above ADMIN above MEMBER", () => {
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.MEMBER);
  });

  it("declares a minimum role for every privileged action", () => {
    for (const [action, min] of Object.entries(PRIVILEGED_ACTIONS)) {
      expect(ROLE_RANK[min], `${action} declares an unknown role`).toBeDefined();
    }
  });
});

describe("roleCan — least privilege", () => {
  it("lets OWNER do everything declared", () => {
    for (const action of Object.keys(PRIVILEGED_ACTIONS) as (keyof typeof PRIVILEGED_ACTIONS)[]) {
      expect(roleCan("OWNER", action), `OWNER should be able to ${action}`).toBe(true);
    }
  });

  it("DENIES MEMBER every privileged action except the one deliberately held", () => {
    // Each of these was reachable by a MEMBER in production before this change.
    //
    // approval:decide is the single exception and it is deliberate, not an
    // oversight: SSO provisions every JIT user as MEMBER, there is no
    // member-management endpoint anywhere in the API, and approvals are a core
    // workflow — so an ADMIN tier would be unreachable and the only remedy
    // would be a manual UPDATE against production. See lib/rbac.ts.
    const DELIBERATELY_MEMBER = new Set(["approval:decide"]);
    for (const action of Object.keys(PRIVILEGED_ACTIONS) as (keyof typeof PRIVILEGED_ACTIONS)[]) {
      if (DELIBERATELY_MEMBER.has(action)) continue;
      expect(roleCan("MEMBER", action), `MEMBER must NOT be able to ${action}`).toBe(false);
    }
  });

  it("holds approval:decide at MEMBER, and says so out loud", () => {
    expect(PRIVILEGED_ACTIONS["approval:decide"]).toBe("MEMBER");
    expect(roleCan("MEMBER", "approval:decide")).toBe(true);
  });

  it("keeps the SPEND CAP off members while preserving tenant-admin operations", () => {
    // Shipping "money is OWNER-only" while leaving the budget knob open made
    // the claim false: a member could raise the cap to the schema max, or null
    // it and disable the cost-anomaly stop entirely.
    expect(roleCan("MEMBER", "billing:budget")).toBe(false);
    expect(roleCan("ADMIN", "billing:budget")).toBe(true);
    expect(roleCan("OWNER", "billing:budget")).toBe(true);
  });

  it("keeps tenant-wide BYOK credentials off MEMBER", () => {
    // Whoever writes settings/ai-config replaces the apiKey AND baseUrl for
    // every user in the tenant — i.e. can point every LLM call at an endpoint
    // of their choosing and exfiltrate prompts and outputs.
    expect(roleCan("MEMBER", "settings:ai-config")).toBe(false);
    expect(roleCan("ADMIN", "settings:ai-config")).toBe(true);
  });

  it("keeps tenant destruction OWNER-only and billing off members", () => {
    expect(roleCan("ADMIN", "billing:checkout")).toBe(true);
    expect(roleCan("ADMIN", "billing:portal")).toBe(true);
    expect(roleCan("ADMIN", "company:delete")).toBe(false);
    expect(roleCan("ADMIN", "billing:budget")).toBe(true);
    expect(roleCan("OWNER", "company:delete")).toBe(true);
  });

  it("lets ADMIN run operational controls that are reversible", () => {
    expect(roleCan("ADMIN", "governance:hard-stop")).toBe(true);
    expect(roleCan("ADMIN", "sso:configure")).toBe(true);
  });

  it("treats an unknown or absent role as no privileges — fail closed", () => {
    for (const bogus of ["", "ROOT", "owner", "Admin", undefined, null, 42]) {
      expect(roleCan(bogus as unknown as AppRole, "company:delete"), `${String(bogus)} must be denied`).toBe(false);
    }
  });

  it("refuses an action that was never declared, rather than defaulting to allow", () => {
    // A typo'd action name must not silently become "permitted".
    expect(roleCan("OWNER", "totally:made-up" as never)).toBe(false);
  });

  it("is not defeated by prototype-chain action names", () => {
    // Same class of bug the product-event allowlist had.
    for (const proto of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(roleCan("OWNER", proto as never), `${proto} must not be a permitted action`).toBe(false);
    }
  });
});
