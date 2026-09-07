import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRequire = createRequire(resolve(ROOT, "packages/ui/package.json"));
const ts = uiRequire("typescript");
const React = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
const LOCALES = ["en", "tr", "es", "de", "fr", "ar"];
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const lookup = (messages, key) => key.split(".").reduce((value, part) => value?.[part], messages);

// Execute the real UI modules with only navigation, translation and transport
// boundaries replaced. No browser, server, store, provider or network is used.
function fixture(locale = "en", mode = "login", fetchImpl = () => { throw new Error("Unexpected network"); }, interaction) {
  const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
  const translate = (namespace) => (key) => {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    const value = lookup(messages, fullKey);
    assert.equal(typeof value, "string", `${locale}: missing ${fullKey}`);
    return value;
  };
  const store = Object.assign((selector) => selector({ token: null, _hydrated: false, setAuth() { throw new Error("Unexpected auth write"); } }), {
    getState() { throw new Error("Auth endpoint must not touch session storage"); },
  });
  const cache = new Map();
  let stateIndex = 0;
  function load(path) {
    const absolute = resolve(ROOT, path);
    if (cache.has(absolute)) return cache.get(absolute);
    const exports = {};
    cache.set(absolute, exports);
    const output = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: absolute,
    }).outputText;
    const require = (id) => {
      if (id === "react") return { ...React, useState: (initial) => {
        const index = stateIndex++;
        const [value, setValue] = React.useState(interaction?.initial?.[index] ?? (initial === "login" ? mode : initial));
        return [value, interaction ? (next) => interaction.updates.push({ index, value: next }) : setValue];
      } };
      if (id === "react/jsx-runtime") {
        const runtime = uiRequire(id);
        const capture = (method) => (type, props, key) => {
          if (interaction && type === "form" && props.noValidate) interaction.submit = props.onSubmit;
          return runtime[method](type, props, key);
        };
        return { ...runtime, jsx: capture("jsx"), jsxs: capture("jsxs") };
      }
      if (id === "next/navigation") return { useRouter: () => ({ replace() { throw new Error("Unexpected navigation"); } }) };
      if (id === "next-intl") return { useTranslations: translate, useLocale: () => locale };
      if (id === "next-intl/server") return { getTranslations: async (namespace) => translate(namespace) };
      if (id.endsWith("/store")) return { useAppStore: store };
      if (id.startsWith(".")) {
        const target = resolve(dirname(absolute), id);
        for (const extension of [".ts", ".tsx"]) {
          try { return load(target + extension); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      throw new Error(`Unexpected import: ${id}`);
    };
    vm.runInNewContext(output, { exports, require, process: { env: {} }, fetch: fetchImpl, Response, Error, console }, { filename: absolute });
    return exports;
  }
  return { load, messages };
}

for (const locale of LOCALES) {
  for (const mode of ["login", "register"]) {
    test(`${locale} ${mode}: actual render has localized copy, language choice and associated fields`, () => {
      const { load, messages } = fixture(locale, mode);
      const Page = load("packages/ui/app/login/page.tsx").default;
      const html = renderToStaticMarkup(React.createElement(Page));
      const expectedText = (text) => renderToStaticMarkup(React.createElement("span", null, text)).slice(6, -7);
      for (const key of ["auth.hero.title", mode === "login" ? "auth.login.newHere" : "auth.register.hasAccount"]) {
        assert.equal(typeof lookup(messages, key), "string", `missing ${locale} ${key}`);
        assert.ok(html.includes(expectedText(lookup(messages, key))), `${locale}: ${key} not rendered`);
      }
      assert.doesNotMatch(html, /3 free runs|Run fully|Remember me|Command the agents you already/);
      assert.match(html, /<select/);
      for (const language of LOCALES) assert.ok(html.includes(`value="${language}"`));
      assert.doesNotMatch(html, /type="checkbox"/);
      const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(new Set(ids).size, mode === "login" ? 2 : 5);
      for (const id of ids) assert.ok(html.includes(`for="${id}"`), `input ${id} has no associated label`);
    });
  }
  test(`${locale}: metadata is localized and remains noindex`, async () => {
    const { load, messages } = fixture(locale);
    const metadata = await load("packages/ui/app/login/layout.tsx").generateMetadata();
    assert.equal(metadata.title, messages.auth.login.tabSignIn);
    assert.equal(metadata.description, messages.auth.login.subtitle);
    assert.equal(metadata.robots.index, false);
    assert.equal(metadata.robots.follow, false);
  });
  test(`${locale}: every auth error key is translated`, () => {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    for (const key of ["generic", "invalidCredentials", "rateLimited", "unavailable"]) {
      assert.equal(typeof messages.auth.errors[key], "string", `${locale}: ${key}`);
      assert.ok(messages.auth.errors[key].trim());
    }
  });
}

test("login responsive and accessible error/reset contracts are explicit", () => {
  const page = read("packages/ui/app/login/page.tsx");
  assert.match(page, /grid-cols-1/);
  assert.match(page, /lg:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(0,\.95fr\)\]/);
  assert.doesNotMatch(page, /gridTemplateColumns/);
  assert.match(page, /min-\[480px\]:grid-cols-3/);
  assert.match(page, /role="alert"/);
  assert.match(page, /aria-label=\{t\("auth\.forgot\.backToLogin"\)\}/);
  assert.match(page, /aria-label=\{t\("auth\.fields\.email"\)\}/);
  assert.doesNotMatch(page, /setError\(msg\s*\|\||set(?:Forgot)?Error\(err instanceof Error/);
});

test("apiFetch preserves HTTP status, detail and request semantics without refreshing anonymous auth", async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    for (const body of [{ message: "server detail" }, { issues: [{ message: "field detail" }] }, { error: "top-level detail" }, null, [], "proxy detail", undefined]) {
      const calls = [];
      const { load } = fixture("en", "login", async (url, options) => {
        calls.push({ url, options });
        return new Response(body === undefined ? "not json" : JSON.stringify(body), { status });
      });
      const { apiFetch, ApiRequestError } = load("packages/ui/lib/api.ts");
      assert.equal(typeof ApiRequestError, "function", "typed HTTP error must be exported");
      await assert.rejects(apiFetch("/auth/login", { method: "POST", body: "{}" }), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, status);
        assert.equal(error.message, body?.message ?? body?.issues?.[0].message ?? body?.error ?? `API error: ${status}`);
        return true;
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.credentials, "include");
      assert.equal(calls[0].options.headers["X-Requested-With"], "XMLHttpRequest");
      assert.equal(calls[0].options.body, "{}");
    }
  }
});

test("auth presentation maps typed statuses, never message contents or unknown errors", () => {
  const { load } = fixture();
  const { ApiRequestError } = load("packages/ui/lib/api.ts");
  const { authErrorKey } = load("packages/ui/lib/auth-errors.ts");
  for (const [status, key] of [[400, "generic"], [401, "invalidCredentials"], [403, "generic"], [409, "generic"], [429, "rateLimited"], [499, "generic"], [500, "unavailable"], [503, "unavailable"], [599, "unavailable"], [600, "generic"]]) {
    assert.equal(authErrorKey(new ApiRequestError(status, "Raw English server response"), { credentials: true }), `auth.errors.${key}`);
  }
  assert.equal(authErrorKey(new ApiRequestError(401, "unauthorized")), "auth.errors.generic");
  for (const error of [null, undefined, "401", { status: 401 }, new Error("Invalid email or password"), new TypeError("Failed to fetch")]) {
    assert.equal(authErrorKey(error, { credentials: true }), "auth.errors.generic");
  }
});

test("real form submission renders localized HTTP categories without storing an auth session", async () => {
  for (const locale of LOCALES) {
    for (const [status, key] of [[401, "invalidCredentials"], [429, "rateLimited"], [503, "unavailable"]]) {
      const interaction = { initial: { 1: "synthetic@example.test", 2: "Synthetic-only-123!" }, updates: [] };
      const { load, messages } = fixture(locale, "login", async () => new Response(JSON.stringify({ message: "Raw English detail" }), { status }), interaction);
      renderToStaticMarkup(React.createElement(load("packages/ui/app/login/page.tsx").default));
      assert.equal(typeof interaction.submit, "function");
      await interaction.submit({ preventDefault() {} });
      assert.equal(interaction.updates.findLast((update) => update.index === 6)?.value, messages.auth.errors[key]);
      assert.equal(interaction.updates.findLast((update) => update.index === 7)?.value, false, "loading must stop after failure");
    }
  }
});
