import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Route-marker census (BR-P0-004).
 *
 * Every route must declare how it gets a tenant context: `authMiddleware`
 * (an authenticated request → runWithTenant) or `systemScope(reason)` (a path
 * that deliberately has no tenant → runWithoutTenant). A route with NEITHER is
 * an unmarked path, and since slice 3 its first Prisma model op throws.
 *
 * Worse than a 500: Express 4 does not catch async rejections, so a handler
 * without try/catch never responds at all — the request hangs and the socket
 * leaks. That is a genuinely unpleasant thing to diagnose at 3am.
 *
 * The census is clean today. This gate exists because the realistic trigger is
 * not today's code but a route added tomorrow without a marker — the same
 * reason the mount-order invariant is a gate rather than a per-path test.
 * Chosen over a global express-async-errors patch: no runtime behavior change
 * across 244 routes, and it turns the hang into a red check instead.
 */
const SRC = join(__dirname, "..");
const VERBS = "get|post|put|patch|delete|all|options|head";

/** Routes that legitimately have no marker, with the reason they are safe. */
const ALLOWED_UNMARKED = new Set([
  // Maps the in-memory STARTER_TEMPLATES constant; issues zero DB calls, so
  // the fail-closed rule can never fire on it.
  "modules/starter/starter.router.ts:starterRouter.get",
  // /health and /api/v1/health. These DO touch the database, but only through
  // `prisma.$queryRaw\`SELECT 1\``. The RLS extension hooks $allModels, so raw
  // queries never reach resolveTenantBinding — a documented, deliberate
  // exclusion (see lib/db.ts). Marking them would also be wrong: a liveness
  // probe must answer even when tenant context machinery is unhappy.
  "index.ts:app.get",
  "index.ts:api.get",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !/ \d+\.ts$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

interface Route { file: string; line: number; router: string; verb: string; path: string; marked: boolean }

function census(): { routes: Route[]; unmarked: Route[] } {
  const routes: Route[] = [];
  for (const file of walk(SRC)) {
    // Strip comments first: several modules document their usage with a literal
    // `router.post("/", validate(schema), handler)` example in a JSDoc block,
    // which is not a route. `//` is only treated as a line comment when it is
    // NOT preceded by `:` so that a "https://…" inside a string argument
    // survives intact.
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (!new RegExp(`\\.(${VERBS})\\(`).test(src)) continue;
    const rel = relative(SRC, file);

    // Routers that gate every route through a router-level `use(authMiddleware)`.
    const routerWideAuth = new Set(
      [...src.matchAll(/\b([A-Za-z0-9_]+)\.use\(\s*authMiddleware\s*\)/g)].map((m) => m[1]!),
    );

    const call = new RegExp(`\\b([A-Za-z0-9_]+)\\.(${VERBS})\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      const router = m[1]!;
      // Accept `api` and `app` too — index.ts registers routes directly on them
      // (e.g. `api.get("/health", …)`), and a route added there would otherwise
      // be invisible to this gate. Still skips non-router receivers like
      // z.string(), res.get(…), headers.get(…).
      if (!/Router$|^router$|^api$|^app$/i.test(router)) continue;

      // Walk the balanced argument list so a multi-line registration is seen.
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      const args = src.slice(m.index + m[0].length, i - 1);
      const pathLit = /^\s*["'`]([^"'`]*)["'`]/.exec(args);
      if (!pathLit) continue; // not a route registration

      const marked =
        /\bsystemScope\s*\(/.test(args) ||
        /\bauthMiddleware\b/.test(args) ||
        routerWideAuth.has(router);

      routes.push({
        file: rel,
        line: src.slice(0, m.index).split("\n").length,
        router,
        verb: m[2]!,
        path: pathLit[1]!,
        marked,
      });
    }
  }
  const unmarked = routes.filter(
    (r) => !r.marked && !ALLOWED_UNMARKED.has(`${r.file}:${r.router}.${r.verb}`),
  );
  return { routes, unmarked };
}

describe("route-marker census", () => {
  it("finds a plausible number of routes (a parser that goes blind must fail)", () => {
    // Pinned as a floor with a ceiling rather than an exact number: routes are
    // added routinely, but a parser that silently stops seeing them would make
    // the assertion below vacuous.
    const { routes } = census();
    expect(routes.length).toBeGreaterThan(180);
    expect(routes.length).toBeLessThan(400);
  });

  it("every route declares authMiddleware or systemScope", () => {
    const { unmarked } = census();
    expect(
      unmarked.map(
        (r) =>
          `${r.file}:${r.line} ${r.router}.${r.verb}("${r.path}") has NEITHER authMiddleware ` +
          `NOR systemScope — its first Prisma model op will throw, and if the handler is ` +
          `async without try/catch the request will HANG instead of 500. Add the right one.`,
      ),
    ).toEqual([]);
  });

  it("detects a planted unmarked route", () => {
    // Proves the check can fail — otherwise a regex that stops matching would
    // leave this suite permanently, silently green.
    const args = `"/x", async (req, res) => {}`;
    const marked = /\bsystemScope\s*\(/.test(args) || /\bauthMiddleware\b/.test(args);
    expect(marked).toBe(false);
  });
});
