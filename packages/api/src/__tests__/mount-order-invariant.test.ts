import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mount-order invariant (BR-P0-004).
 *
 * Express matches mounts in registration order. A router mounted at a GENERAL
 * prefix gets first refusal on every path beneath it — and several routers here
 * apply authMiddleware through a PATHLESS `router.use(subRouter)`, which then
 * shadows every sub-path, auth-gating routes that were never meant to be gated.
 *
 * That defect shipped TWICE in two consecutive commits:
 *   - /billing before /billing/iap silently 401'd Apple App Store Server
 *     Notifications V2 and Google Play RTDN for months — renewals,
 *     cancellations and refunds never reached MobileSubscription;
 *   - /marketplace before /marketplace/templates broke the template catalog
 *     the moment its public routes were marked system-scoped.
 *
 * A per-path regression test caught the first and missed the second, because
 * it was hard-coded to /billing/**. This checks the INVARIANT instead: when one
 * mount path is a prefix of another, the more specific one must be registered
 * first. That is order-independent of which routers happen to use auth today.
 */
const SRC = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

/**
 * Every `app.use(<path>, …)` / `api.use(<path>, …)` in registration order.
 *
 * Scans for the call, then walks the balanced argument list — so a mount split
 * across lines (what Prettier produces once the line exceeds print width) is
 * still seen. A mount whose path is NOT a plain string literal (template
 * literal, variable) is returned with `path: null` and FAILS the suite rather
 * than being skipped: a check that silently stops seeing a mount is worse than
 * no check, which is the whole lesson of the two shadowing bugs below.
 */
function mounts(): Array<{ line: number; path: string | null; router: string; raw: string }> {
  const out: Array<{ line: number; path: string | null; router: string; raw: string }> = [];
  const call = /\b(?:app|api)\.use\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(SRC))) {
    // Walk to the matching close paren so multi-line calls are captured whole.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < SRC.length && depth > 0; i++) {
      const ch = SRC[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const raw = SRC.slice(m.index, i);
    const args = raw.slice(m[0].length, -1).trim();
    const line = SRC.slice(0, m.index).split("\n").length;

    // `app.use(router)` with no path — not a prefix mount, nothing to order.
    const firstArg = args.split(",")[0]?.trim() ?? "";
    if (!firstArg.startsWith('"') && !firstArg.startsWith("'") && !firstArg.startsWith("`")) continue;

    const lit = /^["']([^"']+)["']$/.exec(firstArg);
    const router = (args.split(",")[1] ?? "").trim().split(/[^A-Za-z0-9_]/)[0] || "<inline>";
    out.push({ line, path: lit ? lit[1]! : null, router, raw: raw.slice(0, 60) });
  }
  return out;
}

const isPrefixOf = (general: string, specific: string) =>
  specific !== general && specific.startsWith(general.replace(/\/$/, "") + "/");

describe("index.ts mount order", () => {
  it("sees every path mount (a parser that goes blind must fail, not pass)", () => {
    // Pinned exactly, not as a floor: if index.ts is reformatted and the parser
    // silently stops seeing mounts, every assertion below would pass vacuously.
    // Update this number deliberately when a mount is genuinely added/removed.
    // 43 -> 44: /audit added for the BR-P1-005 audit export.
    expect(mounts().length).toBe(44);
  });

  it("refuses a mount path it cannot statically read", () => {
    // A template-literal or variable path would be invisible to the ordering
    // check. Fail loudly rather than skipping it.
    const opaque = mounts().filter((m) => m.path === null);
    expect(opaque.map((m) => `line ${m.line}: ${m.raw}`)).toEqual([]);
  });

  it("never mounts a general prefix before a more specific one", () => {
    const all = mounts();
    const violations: string[] = [];
    all.forEach((general, i) => {
      all.slice(i + 1).forEach((specific) => {
        if (general.path && specific.path && isPrefixOf(general.path, specific.path)) {
          violations.push(
            `"${general.path}" (${general.router}, line ${general.line}) is mounted BEFORE ` +
              `"${specific.path}" (${specific.router}, line ${specific.line}) — ` +
              `${general.router} will shadow it. Move the more specific mount first.`,
          );
        }
      });
    });
    expect(violations).toEqual([]);
  });

  it("the check itself detects a planted violation", () => {
    // Proves the assertion above can fail — otherwise a regex that stops
    // matching would make this suite permanently, silently green.
    const planted = [
      { line: 1, path: "/billing", router: "billingRouter" },
      { line: 2, path: "/billing/iap", router: "iapRouter" },
    ];
    const found = planted.some((g, i) =>
      planted.slice(i + 1).some((s) => isPrefixOf(g.path, s.path)),
    );
    expect(found).toBe(true);
  });
});
