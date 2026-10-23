import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRequire = createRequire(resolve(ROOT, "packages/ui/package.json"));
// Next's server bootstrap normally provides this global before loading its
// request stores. Use Node's real implementation for this in-process harness.
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const { workAsyncStorage } = uiRequire("next/dist/server/app-render/work-async-storage.external");
const { workUnitAsyncStorage } = uiRequire("next/dist/server/app-render/work-unit-async-storage.external");
const { connection } = uiRequire("next/dist/server/request/connection");
const ts = uiRequire("typescript");
const React = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");

// The page renders English catalog copy; a stand-in for next-intl's server
// helpers keeps this harness hermetic while still resolving real messages.
const ENGLISH = JSON.parse(readFileSync(resolve(ROOT, "packages/ui/messages/en.json"), "utf8"));
function translator(namespace) {
  return (key, values = {}) => {
    const message = `${namespace}.${key}`.split(".").reduce((node, part) => node?.[part], ENGLISH);
    if (typeof message !== "string") throw new Error(`Missing English message ${namespace}.${key}`);
    return message.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
  };
}

function loadModule(filename, fetchImpl) {
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  const require = (id) => {
    if (id === "next/server") return { connection };
    if (id === "next-intl/server") return { getLocale: async () => "en", getTranslations: async (namespace) => translator(namespace) };
    if (id === "react/jsx-runtime") return uiRequire(id);
    if (id === "next/link") return {
      __esModule: true,
      default: ({ children, ...props }) => React.createElement("a", props, children),
    };
    // Only the page's own pure helpers (formatting, title) load from source.
    if (["../../i18n/locales", "../../lib/brand-title"].includes(id)) return loadModule(resolve(dirname(filename), `${id}.ts`), fetchImpl);
    throw new Error(`Unexpected Bench import: ${id}`);
  };
  vm.runInNewContext(output, {
    exports, require, fetch: fetchImpl,
    process: { env: { NEXT_PUBLIC_API_URL: "https://api.fixture.invalid/api/v1" } },
    console, Intl,
  }, { filename });
  return exports;
}

function actualPage(fetchImpl) {
  return loadModule(resolve(ROOT, "packages/ui/app/bench/page.tsx"), fetchImpl).default;
}

function inRenderScope(unit, action) {
  const work = { route: "/bench", isStaticGeneration: unit.type !== "request" };
  return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, action));
}

test("legacy prerender stops before the public API is fetched", async () => {
  const calls = [];
  const page = actualPage(async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => [] };
  });
  await assert.rejects(inRenderScope({ type: "prerender-legacy", phase: "render", revalidate: 3600 }, page),
    (error) => error.digest === "DYNAMIC_SERVER_USAGE");
  assert.equal(calls.length, 0, "building the page must not probe a live API");
});

test("dynamic prerender waits for a real request without calling the API", async () => {
  const calls = [];
  const controller = new AbortController();
  const page = actualPage(async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => [] };
  });
  const pending = inRenderScope({ type: "prerender", phase: "render", renderSignal: controller.signal }, page);
  const settled = pending.then(() => null, (error) => error);
  await Promise.resolve();
  controller.abort();
  const error = await settled;
  assert.equal(calls.length, 0, "no data request may cross the prerender boundary");
  assert.equal(error?.digest, "HANGING_PROMISE_REJECTION");
});

test("request rendering keeps the real endpoint, hourly cache option and leaderboard", async () => {
  const calls = [];
  const page = actualPage(async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => [{
      id: "fixture-suite", slug: "reasoning", name: "Fixture reasoning", description: "Synthetic test data",
      maxScorePerTask: 1, leaderboard: [{
        id: "fixture-run", provider: "fixture-provider", model: "fixture-model",
        scoreNormalised: 0.875, costUsd: "0.012", durationMs: 2400, ranAt: "2026-10-01T00:00:00Z",
      }],
    }] };
  });
  const tree = await inRenderScope({ type: "request", phase: "render" }, page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.fixture.invalid/api/v1/bench");
  assert.equal(calls[0][1].next.revalidate, 3600);
  const html = renderToStaticMarkup(tree);
  for (const value of ["Fixture reasoning", "fixture-provider", "fixture-model", "87.5%", "$0.012", "2026-10-01"]) {
    assert.ok(html.includes(value), `request output must retain ${value}`);
  }
});

test("request transport failure retains the existing empty-state rendering", async () => {
  let calls = 0;
  const page = actualPage(async () => { calls++; throw new Error("Synthetic offline fixture"); });
  const tree = await inRenderScope({ type: "request", phase: "render" }, page);
  assert.equal(calls, 1);
  // The empty state names no delivery schedule (the copy no longer promises a weekly cycle).
  const html = renderToStaticMarkup(tree);
  assert.ok(html.includes(ENGLISH.uiCopy.mbe9a5bbdd9b6), "existing empty-state copy renders");
  assert.doesNotMatch(html, /weekly|next .* cycle/i);
});

test("a missing request scope fails before any API call", async () => {
  let calls = 0;
  const page = actualPage(async () => { calls++; return { ok: true, json: async () => [] }; });
  await assert.rejects(page, /outside a request scope/);
  assert.equal(calls, 0);
});
