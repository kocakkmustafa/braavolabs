import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(UI, "package.json"));
const ts = req("typescript");
const jsx = req("react/jsx-runtime");
const { createTranslator } = req("next-intl");
const read = file => readFileSync(resolve(UI, file), "utf8");
function load(file, globals = {}, boundaries = {}) {
  const output = ts.transpileModule(read(file), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(output.diagnostics?.length, 0, `${file} syntax`);
  const exports = {};
  vm.runInNewContext(output.outputText, { exports, ...globals, require: name => {
    if (name === "react/jsx-runtime") return jsx;
    if (name in boundaries) return boundaries[name];
    throw new Error(`Uncontrolled boundary: ${name}`);
  } });
  return exports;
}

function fixture(initial) {
  const values = new Map(initial === undefined ? [] : [["cookie_consent", initial]]);
  const nodes = new Map(), handlers = new Map();
  const log = { append: [], removed: 0, reload: 0, failRead: false, failWrite: false, failRemove: false, ignoreWrite: false };
  const window = {
    localStorage: {
      getItem(key) { if (log.failRead) throw Error("read denied"); return values.get(key) ?? null; },
      setItem(key, value) { if (log.failWrite) throw Error("write denied"); if (!log.ignoreWrite) values.set(key, value); },
      removeItem(key) { if (log.failRemove) throw Error("remove denied"); values.delete(key); },
    },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    location: { reload() { log.reload++; } },
    plausible() { throw Error("real analytics must never execute"); },
  };
  const document = {
    cookie: "cf_country=TR",
    getElementById: id => nodes.get(id) ?? null,
    createElement(tag) {
      assert.equal(tag, "script");
      return { dataset: {}, remove() { nodes.delete(this.id); log.removed++; } };
    },
    head: { appendChild(node) { nodes.set(node.id, node); log.append.push(node); } },
  };
  const globals = { window, document, navigator: { language: "tr" } };
  const consent = load("lib/cookie-consent.ts", globals);
  const analytics = load("lib/optional-analytics.ts", globals, { "./cookie-consent": consent });
  const start = () => analytics.startOptionalAnalytics("fixture.invalid", analytics.browserAnalyticsBoundary());
  const storage = (key = "cookie_consent") => { for (const fn of handlers.get("storage") ?? []) fn({ key }); };
  return { values, log, window, document, globals, consent, analytics, start, storage, handlers };
}

test("SSR has no browser storage or script side effect", () => {
  const consent = load("lib/cookie-consent.ts");
  assert.equal(consent.getCookieConsent(), null);
  assert.equal(consent.setCookieConsent("accepted"), false);
  assert.equal(consent.clearCookieConsent(), false);
});

test("no choice, invalid, essential-only, and storage read error load zero scripts", () => {
  for (const value of [undefined, "invalid", "essential-only"]) {
    const f = fixture(value); f.start(); assert.equal(f.log.append.length, 0);
  }
  const f = fixture("accepted"); f.log.failRead = true; f.start();
  assert.equal(f.log.append.length, 0);
});

test("verified accept loads exactly one owned script; repeats do not duplicate it", () => {
  const f = fixture(); f.start();
  assert.equal(f.consent.setCookieConsent("accepted"), true);
  assert.equal(f.log.append.length, 1);
  assert.equal(f.log.append[0].src, "https://plausible.io/js/script.outbound-links.js");
  assert.equal(f.log.append[0].dataset.domain, "fixture.invalid");
  f.consent.setCookieConsent("accepted"); f.storage();
  assert.equal(f.log.append.length, 1);
});

test("decline never loads analytics; storage write/readback failure cannot grant", () => {
  const decline = fixture(); decline.start();
  assert.equal(decline.consent.setCookieConsent("essential-only"), true);
  assert.equal(decline.log.append.length, 0);
  for (const failure of ["failWrite", "ignoreWrite", "failRead"]) {
    const f = fixture(); f.start(); f.log[failure] = true;
    assert.equal(f.consent.setCookieConsent("accepted"), false);
    assert.equal(f.consent.getCookieConsent(), null);
    assert.equal(f.log.append.length, 0);
  }
});

test("verified clear disables the global, removes the script, and requests one reload", () => {
  const f = fixture("accepted"); f.start();
  assert.equal(f.consent.clearCookieConsent(), true);
  assert.equal(f.consent.getCookieConsent(), null);
  assert.equal(f.log.removed, 1);
  assert.equal(f.log.reload, 1);
  assert.doesNotThrow(() => f.window.plausible("fixture-event"));
  f.storage(); assert.equal(f.log.reload, 1);
  assert.equal(f.log.append.length, 1);
});

test("failed clear returns false, blocks a later storage grant, and does not reload accepted storage", () => {
  const f = fixture("accepted"); f.start(); f.log.failRemove = true;
  assert.equal(f.consent.clearCookieConsent(), false);
  assert.equal(f.values.get("cookie_consent"), "accepted");
  assert.equal(f.consent.getCookieConsent(), null);
  assert.equal(f.log.removed, 1); assert.equal(f.log.reload, 0);
  f.storage(); assert.equal(f.consent.getCookieConsent(), null);
  assert.equal(f.log.append.length, 1);
  assert.doesNotThrow(() => f.window.plausible("fixture-event"));
});

test("clear read failure reports false and cannot trigger an unsafe reload", () => {
  const f = fixture("accepted"); f.start(); f.log.failRead = true;
  assert.equal(f.consent.clearCookieConsent(), false);
  assert.equal(f.log.removed, 1); assert.equal(f.log.reload, 0);
});

test("retrying a failed withdrawal still reloads after the owned script has been removed", () => {
  const f = fixture("accepted"); const stop = f.start(); f.log.failRemove = true;
  assert.equal(f.consent.clearCookieConsent(), false);
  assert.equal(f.log.removed, 1); assert.equal(f.log.reload, 0);
  stop(); f.start(); // A React remount must not forget already-loaded listeners.
  f.log.failRemove = false;
  assert.equal(f.consent.clearCookieConsent(), true);
  assert.equal(f.log.removed, 1); assert.equal(f.log.reload, 1);
});

test("cross-tab decline or storage clear removes loaded analytics and requests reload", () => {
  for (const choice of ["essential-only", undefined]) {
    const f = fixture("accepted"); f.start();
    if (choice) f.values.set("cookie_consent", choice); else f.values.clear();
    f.storage(choice ? "cookie_consent" : null);
    assert.equal(f.log.removed, 1); assert.equal(f.log.reload, 1);
  }
});

test("effect unmount/remount does not revoke, duplicate a script, or reload", () => {
  const f = fixture("accepted"); const stop = f.start(); stop(); f.start();
  assert.equal(f.log.append.length, 1); assert.equal(f.log.removed, 0); assert.equal(f.log.reload, 0);
});

test("subscriptions share one storage listener and release it; unrelated events are ignored", () => {
  const f = fixture(); let updates = 0;
  const a = f.consent.subscribeCookieConsent(() => updates++);
  const b = f.consent.subscribeCookieConsent(() => updates++);
  assert.equal(f.handlers.get("storage").size, 1);
  f.storage("unrelated"); assert.equal(updates, 0);
  f.storage(); assert.equal(updates, 2);
  a(); b(); assert.equal(f.handlers.get("storage").size, 0);
});

function hooks() {
  const states = [], refs = [], effects = [];
  let index = 0, refIndex = 0, effectIndex = 0;
  return {
    react: {
      useState(initial) { const i = index++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
      useRef(initial) { const i = refIndex++; return refs[i] ??= { current: initial }; },
      useEffect(fn) { const i = effectIndex++; if (!(i in effects)) effects[i] = { fn }; },
    },
    render(component) { index = 0; refIndex = 0; effectIndex = 0; return component(); },
    mount() { for (const item of effects) { if (!item.mounted) { item.cleanup = item.fn(); item.mounted = true; } } },
  };
}
function elements(node, predicate, result = []) {
  if (Array.isArray(node)) for (const child of node) elements(child, predicate, result);
  else if (node && typeof node === "object" && node.props) {
    if (predicate(node)) result.push(node);
    elements(node.props.children, predicate, result);
  }
  return result;
}
const canonical = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar"];
test("actual banner uses next-intl locale and catalog text in eight languages, native controls and RTL", () => {
  for (const locale of canonical) {
    const f = fixture(), h = hooks();
    const messages = JSON.parse(read(`messages/${locale}.json`));
    const t = createTranslator({ locale, messages, namespace: "static.cookieConsent" });
    const component = load("components/CookieConsent.tsx", f.globals, {
      react: h.react, "next-intl": { useLocale: () => locale, useTranslations: () => t },
      "../lib/cookie-consent": f.consent,
    }).default;
    assert.equal(h.render(component), null); h.mount();
    const tree = h.render(component);
    assert.equal(tree.props.lang, locale); assert.equal(tree.props.dir, locale === "ar" ? "rtl" : "ltr");
    assert.equal(elements(tree, n => n.props.id === "cookie-consent-title")[0].props.children, t("title"));
    const buttons = elements(tree, n => n.type === "button");
    assert.equal(buttons.length, 2);
    for (const button of buttons) { assert.equal(button.props.type, "button"); assert.equal(button.props.style.minHeight, 44); }
    assert.equal(buttons[1].props.children, t("acceptAll"));
    buttons[0].props.onClick(); assert.equal(h.render(component), null);
    assert.equal(f.consent.getCookieConsent(), "essential-only");
  }
});

test("actual banner renders a translated storage failure rather than accepting", () => {
  const f = fixture(), h = hooks(); f.log.failWrite = true;
  const messages = JSON.parse(read("messages/ja.json"));
  const t = createTranslator({ locale: "ja", messages, namespace: "static.cookieConsent" });
  const component = load("components/CookieConsent.tsx", f.globals, {
    react: h.react, "next-intl": { useLocale: () => "ja", useTranslations: () => t }, "../lib/cookie-consent": f.consent,
  }).default;
  h.render(component); h.mount();
  elements(h.render(component), n => n.type === "button")[1].props.onClick();
  assert.equal(elements(h.render(component), n => n.props.role === "alert")[0].props.children, t("saveFailed"));
});

test("actual cookies page resets with explicit success/failure and localized preferences", () => {
  for (const locale of canonical) for (const failure of [false, true]) {
    const f = fixture("accepted"), h = hooks(); f.log.failRemove = failure;
    const messages = JSON.parse(read(`messages/${locale}.json`));
    const component = load("app/cookies/page.tsx", f.globals, {
      react: h.react,
      "next-intl": { useTranslations: namespace => createTranslator({ locale, messages, namespace }) },
      "../../components/CookieConsent": f.consent,
    }).default;
    const t = createTranslator({ locale, messages, namespace: "static.cookieConsent" });
    let tree = h.render(component);
    const reset = elements(tree, n => n.type === "button" && n.props.children?.includes?.(t("reset")))[0];
    assert.ok(reset, `${locale} reset button`); reset.props.onClick();
    tree = h.render(component);
    assert.equal(elements(tree, n => n.props.role === (failure ? "alert" : "status")).length, 1);
    if (failure) assert.equal(elements(tree, n => n.props.role === "status").length, 0);
  }
});

test("actual root layout sends consent messages in the public slim payload and has no eager tracker script", async () => {
  const Provider = () => null, Analytics = () => null;
  for (const locale of canonical) for (const pathname of ["/", "/pricing", "/contact", "/cookies", "/privacy", "/terms", "/legal/account-deletion", "/gdpr", "/kvkk"]) {
    const messages = JSON.parse(read(`messages/${locale}.json`));
    const layout = load("app/layout.tsx", { process: { env: { NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "fixture.invalid" } } }, {
      "next/headers": { headers: async () => ({ get: key => ({ host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": pathname })[key] ?? null }) },
      "next-intl": { NextIntlClientProvider: Provider },
      "next-intl/server": { getLocale: async () => locale, getMessages: async () => messages },
      "./AuthLayout": { default: () => null },
      "../components/CookieConsent": { default: () => null },
      "../components/OptionalAnalytics": { default: Analytics },
      "../components/SkipLink": { default: () => null },
      "../components/Toast": { ToastProvider: () => null },
      "../lib/surface-domain": load("lib/surface-domain.ts", { URL }),
      "./globals.css": {},
    }).default;
    const tree = await layout({ children: "fixture-content" });
    assert.equal(tree.props.lang, locale); assert.equal(tree.props.dir, locale === "ar" ? "rtl" : "ltr");
    const payload = elements(tree, n => n.type === Provider)[0].props.messages;
    assert.equal(payload.static.cookieConsent, messages.static.cookieConsent);
    assert.equal(payload.app, undefined);
    assert.equal(elements(tree, n => n.type === "script" && n.props.src).length, 0);
    assert.equal(elements(tree, n => n.type === Analytics)[0].props.domain, "fixture.invalid");
  }
});

test("same-host self-hosted public/private surfaces never mount optional analytics", async () => {
  const Analytics = () => null;
  const surface = load("lib/surface-domain.ts", { URL });
  const allowedHosts = surface.parseSelfHostedSurfaceHosts("preview.example.com");
  assert.equal(surface.surfaceForHost("preview.example.com", "/pricing", allowedHosts), "public");
  assert.equal(surface.surfaceForHost("preview.example.com", "/dashboard", allowedHosts), "authenticated");
  for (const [host, pathname, requestSurface, expected] of [
    ["www.braavolabs.com", "/pricing", "public", 1],
    ["WWW.BRAAVOLABS.COM:443", "/pricing", "public", 1],
    ["braavolabs.com", "/pricing", "public", 1],
    ["preview.example.com", "/pricing", "public", 0],
    ["preview.example.com", "/dashboard", "authenticated", 0],
    ["app.braavolabs.com", "/dashboard", "authenticated", 0],
    ["localhost:3007", "/pricing", "public", 0],
    ["unknown.example.com", "/pricing", "public", 0],
  ]) {
    const layout = load("app/layout.tsx", { process: { env: {
      NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "fixture.invalid", SELF_HOSTED_SURFACE_HOSTS: "preview.example.com",
    } } }, {
      "next/headers": { headers: async () => ({ get: key => ({ host, "x-braavolabs-surface": requestSurface, "x-braavolabs-pathname": pathname })[key] ?? null }) },
      "next-intl": { NextIntlClientProvider: () => null },
      "next-intl/server": { getLocale: async () => "en", getMessages: async () => JSON.parse(read("messages/en.json")) },
      "./AuthLayout": { default: () => null },
      "../components/CookieConsent": { default: () => null },
      "../components/OptionalAnalytics": { default: Analytics },
      "../components/SkipLink": { default: () => null },
      "../components/Toast": { ToastProvider: () => null },
      "../lib/surface-domain": surface, "./globals.css": {},
    }).default;
    const tree = await layout({ children: "fixture" });
    assert.equal(elements(tree, n => n.type === Analytics).length, expected, `${host}${pathname}`);
    assert.equal(elements(tree, n => n.type === "script" && n.props.src).length, 0);
  }
});
