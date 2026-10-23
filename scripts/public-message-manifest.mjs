#!/usr/bin/env node
// Public-surface client message manifest (BRV-09).
//
// Public pages hand the browser a NextIntlClientProvider payload. Sending the
// whole `uiCopy` and `surface` catalogues (~40-55 KB per page) is wasteful: a
// page's client components use a few dozen of the ~700 uiCopy ids. This script
// walks each public route's static import graph and records, per route, what
// its CLIENT modules can read:
//   - uiCopy: every literal id (m + 12 hex) in a client module;
//   - surface/runtime: every literal namespace or key path ("surface.error",
//     `surface.states.${x}` -> its static prefix). A bare "surface"/"runtime"
//     keeps the whole namespace, so dynamic keys are never cut.
// A module is client if it says "use client" or is imported by a client module.
// The result is committed (packages/ui/lib/public-message-manifest.generated.ts);
// public-message-manifest.test.mjs regenerates it and fails on drift.
//
//   node scripts/public-message-manifest.mjs          # rewrite the manifest
//   node scripts/public-message-manifest.mjs --check  # exit 1 if stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "packages/ui");
export const MANIFEST_PATH = join(UI, "lib/public-message-manifest.generated.ts");

// Route key -> page module. Dynamic public prefixes map to their [slug] page.
export const PUBLIC_ROUTE_PAGES = {
  "/": "app/page.tsx",
  "/features": "app/features/page.tsx",
  "/pricing": "app/pricing/page.tsx",
  "/security": "app/security/page.tsx",
  "/docs": "app/docs/page.tsx",
  "/docs/[slug]": "app/docs/[slug]/page.tsx",
  "/status": "app/status/page.tsx",
  "/support": "app/support/page.tsx",
  "/about": "app/about/page.tsx",
  "/blog": "app/blog/page.tsx",
  "/blog/[slug]": "app/blog/[slug]/page.tsx",
  "/changelog": "app/changelog/page.tsx",
  "/compare": "app/compare/page.tsx",
  "/contact": "app/contact/page.tsx",
  "/cookies": "app/cookies/page.tsx",
  "/cost-calculator": "app/cost-calculator/page.tsx",
  "/gdpr": "app/gdpr/page.tsx",
  "/kvkk": "app/kvkk/page.tsx",
  "/privacy": "app/privacy/page.tsx",
  "/terms": "app/terms/page.tsx",
  "/legal/account-deletion": "app/legal/account-deletion/page.tsx",
};
// Client chrome the root layout renders on every public page (AuthLayout is
// authenticated-only and deliberately excluded), plus the route segment files
// Next renders around a page: every ancestor layout/template/loading/error/
// not-found (error.tsx is a client component that shows copy on failure).
const LAYOUT_SHELL = ["app/layout.tsx"];
const LAYOUT_EXCLUDE = new Set(["app/AuthLayout.tsx"]);
const SEGMENT_FILES = ["layout.tsx", "template.tsx", "loading.tsx", "error.tsx", "not-found.tsx"];

function segmentFiles(page) {
  const files = [];
  const parts = dirname(page).split("/"); // "app", "legal", "account-deletion"
  for (let depth = 1; depth <= parts.length; depth++) {
    const dir = parts.slice(0, depth).join("/");
    for (const name of SEGMENT_FILES) if (existsSync(join(UI, dir, name))) files.push(`${dir}/${name}`);
  }
  return files;
}

const UI_COPY_ID = /\bm[0-9a-f]{12}\b/g;
const NAMESPACE_PATH = /["'`]((?:surface|runtime)(?:\.[A-Za-z0-9_-]+)*)(?:\.\$\{|["'`])/g;
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const read = (file) => readFileSync(join(UI, file), "utf8");
const isClientSource = (source) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(UI, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(join(UI, dirname(from)), spec);
  else return null; // packages and next/* carry no catalogue keys
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(".css") && /\.(tsx?|mjs|js)$/.test(candidate)) return relative(UI, candidate);
  }
  return null;
}

/** Modules reachable from the entries, with client context propagated. */
function walk(entries) {
  const client = new Set();
  const seen = new Map(); // file -> client context
  const queue = entries.map((file) => [file, false]);
  while (queue.length) {
    const [file, inherited] = queue.shift();
    if (LAYOUT_EXCLUDE.has(file)) continue;
    const source = read(file);
    const isClient = inherited || isClientSource(source);
    if (seen.has(file) && (seen.get(file) || !isClient)) continue;
    seen.set(file, isClient);
    if (isClient) client.add(file);
    for (const match of source.matchAll(IMPORT)) {
      const target = resolveImport(file, match[1] ?? match[2]);
      if (target && !target.includes(".test.")) queue.push([target, isClient]);
    }
  }
  return [...client].sort();
}

function collapse(paths) {
  // Keep only the shortest covering paths: "surface" swallows "surface.error".
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept = [];
  for (const path of sorted) if (!kept.some((k) => path === k || path.startsWith(`${k}.`))) kept.push(path);
  return kept.sort();
}

export function buildManifest() {
  const knownIds = new Set(Object.keys(JSON.parse(read("messages/en.json")).uiCopy));
  const routes = {};
  for (const [route, page] of Object.entries(PUBLIC_ROUTE_PAGES)) {
    if (!existsSync(join(UI, page))) continue;
    const modules = walk([...LAYOUT_SHELL, ...segmentFiles(page), page]);
    const ids = new Set();
    const paths = [];
    for (const file of modules) {
      const source = read(file);
      for (const [id] of source.matchAll(UI_COPY_ID)) if (knownIds.has(id)) ids.add(id);
      for (const match of source.matchAll(NAMESPACE_PATH)) paths.push(match[1]);
    }
    const namespaces = collapse(paths);
    routes[route] = {
      uiCopy: [...ids].sort(),
      surface: namespaces.filter((p) => p === "surface" || p.startsWith("surface.")),
      runtime: namespaces.filter((p) => p === "runtime" || p.startsWith("runtime.")),
    };
  }
  return routes;
}

export function renderManifest(routes) {
  return `// GENERATED by scripts/public-message-manifest.mjs — do not edit by hand.
// Per public route: the uiCopy ids and surface/runtime paths its client modules
// can read. Regenerate after changing public pages or their client components.
export const PUBLIC_MESSAGE_MANIFEST: Record<string, { uiCopy: readonly string[]; surface: readonly string[]; runtime: readonly string[] }> = ${JSON.stringify(routes, null, 2)};
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = renderManifest(buildManifest());
  if (process.argv.includes("--check")) {
    const current = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, "utf8") : "";
    if (current !== next) { console.error("public-message manifest is stale: run node scripts/public-message-manifest.mjs"); process.exit(1); }
  } else {
    writeFileSync(MANIFEST_PATH, next);
    console.log(`wrote ${relative(ROOT, MANIFEST_PATH)}`);
  }
}
