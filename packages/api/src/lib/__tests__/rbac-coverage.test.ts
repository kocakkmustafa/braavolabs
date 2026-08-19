import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PRIVILEGED_ACTIONS } from "../rbac";

/**
 * BR-P1-005 — every declared action must actually be applied somewhere.
 *
 * The matrix is not the enforcement inventory. Nothing fails if an action is
 * declared and never wired, which is exactly what happened INSIDE the commit
 * that introduced the matrix: `sso:configure` was declared, while sso.router.ts
 * kept its own inline role comparison — two sources of truth, and a later edit
 * to the matrix entry would have silently changed nothing.
 *
 * That is the same decorative-layer pattern the whole task exists to end, so it
 * gets a mechanical check rather than a promise to remember.
 */
const SRC = join(__dirname, "..", "..");

/**
 * Source with comments stripped. Without this, a doc comment that MENTIONS the
 * banned pattern (require-permission.ts explains why `requireRole(...)` was
 * removed) trips the check — a gate defeated by its own documentation, the same
 * way the CI lint comment nearly was. `//` is only a line comment when NOT
 * preceded by `:`, so a "https://…" in a string survives.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !/ \d+\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Where each declared action is applied via requirePermission("<action>"). */
function applications(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const action of Object.keys(PRIVILEGED_ACTIONS)) found.set(action, []);
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("requirePermission(")) continue;
    for (const action of Object.keys(PRIVILEGED_ACTIONS)) {
      if (src.includes(`requirePermission("${action}")`)) {
        found.get(action)!.push(relative(SRC, file));
      }
    }
  }
  return found;
}

describe("rbac coverage", () => {
  it("every declared action is applied to at least one route", () => {
    const unwired = [...applications().entries()]
      .filter(([, files]) => files.length === 0)
      .map(([action]) =>
        `"${action}" is declared in PRIVILEGED_ACTIONS but no route calls requirePermission("${action}") — ` +
        `either wire it or remove it, but do not leave a declared-and-unenforced action`,
      );
    expect(unwired).toEqual([]);
  });

  it("finds a plausible number of applications (a parser that goes blind must fail)", () => {
    const total = [...applications().values()].reduce((n, f) => n + f.length, 0);
    expect(total).toBeGreaterThanOrEqual(Object.keys(PRIVILEGED_ACTIONS).length);
  });

  it("no route uses the deleted requireRole helper", () => {
    // It was exported for a long time and applied by zero routes, which is how
    // this whole class of hole opened. Removed; this keeps it removed.
    const offenders = walk(SRC)
      .filter((f) => /\brequireRole\s*\(/.test(code(f)))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no module route still does an inline role comparison", () => {
    // Two sources of truth is how sso:configure ended up declared-but-inert.
    const offenders = walk(join(SRC, "modules"))
      .filter((f) => /req\.auth!?\.role\s*[!=]==/.test(code(f)))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
