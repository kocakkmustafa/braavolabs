import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifest, MANIFEST_PATH, PUBLIC_ROUTE_PAGES, renderManifest } from "./public-message-manifest.mjs";

const UI = join(import.meta.dirname, "..", "packages/ui");
const read = (path) => readFileSync(join(UI, path), "utf8");
const LOCALES = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"];

test("committed public-message manifest matches the current public client graph", () => {
  assert.equal(readFileSync(MANIFEST_PATH, "utf8"), renderManifest(buildManifest()),
    "stale manifest: run node scripts/public-message-manifest.mjs");
});

test("every public page route with a page module has a manifest entry", () => {
  const source = read("lib/surface-domain.ts");
  const exact = source.match(/const PUBLIC_EXACT_PATHS = new Set\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(exact, "PUBLIC_EXACT_PATHS literal");
  const paths = [...exact.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const path of paths) {
    const page = path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
    if (existsSync(join(UI, page))) assert.equal(PUBLIC_ROUTE_PAGES[path], page, `${path} missing from PUBLIC_ROUTE_PAGES`);
  }
  for (const prefix of ["/docs/", "/blog/"]) {
    assert.ok(PUBLIC_ROUTE_PAGES[`${prefix}[slug]`], `${prefix}[slug] covered`);
  }
});

test("manifest keys exist in all 14 catalogues", () => {
  const manifest = buildManifest();
  for (const locale of LOCALES) {
    const messages = JSON.parse(read(`messages/${locale}.json`));
    for (const [route, entry] of Object.entries(manifest)) {
      for (const id of entry.uiCopy) assert.equal(typeof messages.uiCopy[id], "string", `${locale} ${route} uiCopy.${id}`);
      for (const path of [...entry.surface, ...entry.runtime]) {
        const value = path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), messages);
        assert.notEqual(value, undefined, `${locale} ${route} ${path}`);
      }
    }
  }
});

test("the root layout narrows public client messages through the manifest", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /import \{ PUBLIC_MESSAGE_MANIFEST \} from "\.\.\/lib\/public-message-manifest\.generated";/);
  assert.match(layout, /pickCatalogue\(messages, entry\.uiCopy\.map\(\(id\) => `uiCopy\.\$\{id\}`\)\)/);
  assert.match(layout, /const \{ uiCopy, surface, runtime \} = publicClientNamespaces\(messages, pathname\);/);
  // A route without an entry falls back to the full namespaces instead of dropping copy.
  assert.match(layout, /if \(!entry\) return \{ uiCopy: record\(record\(messages\)\.uiCopy\)/);
});
