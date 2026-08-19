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

/** Every `app.use("/path", …)` / `api.use("/path", …)` in registration order. */
function mounts(): Array<{ line: number; path: string; router: string }> {
  const out: Array<{ line: number; path: string; router: string }> = [];
  SRC.split("\n").forEach((text, i) => {
    const m = /^\s*(?:app|api)\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_]+)/.exec(text);
    if (m) out.push({ line: i + 1, path: m[1], router: m[2] });
  });
  return out;
}

const isPrefixOf = (general: string, specific: string) =>
  specific !== general && specific.startsWith(general.replace(/\/$/, "") + "/");

describe("index.ts mount order", () => {
  it("parses a plausible number of path mounts (guards the regex itself)", () => {
    // If index.ts is reformatted and the regex silently matches nothing, every
    // assertion below would pass vacuously. Pin a floor.
    expect(mounts().length).toBeGreaterThan(30);
  });

  it("never mounts a general prefix before a more specific one", () => {
    const all = mounts();
    const violations: string[] = [];
    all.forEach((general, i) => {
      all.slice(i + 1).forEach((specific) => {
        if (isPrefixOf(general.path, specific.path)) {
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
