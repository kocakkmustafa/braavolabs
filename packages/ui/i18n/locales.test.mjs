import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(UI, "package.json"));
const ts = req("typescript");
const React = req("react");
const jsx = req("react/jsx-runtime");
const { createTranslator } = req("next-intl");
let parserRequire = req;
for (const name of ["next-intl", "use-intl", "intl-messageformat"]) parserRequire = createRequire(parserRequire.resolve(name));
const { parse } = await import(pathToFileURL(parserRequire.resolve("@formatjs/icu-messageformat-parser")).href);
const read = file => readFileSync(resolve(UI, file), "utf8");
const messages = code => JSON.parse(read(`messages/${code}.json`));
const compile = file => ts.transpileModule(read(file), {
  fileName: file,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
function load(file, boundaries = {}) {
  const exports = {};
  vm.runInNewContext(compile(file), { exports, Intl, Date, process: { env: {} },
    require: name => {
      if (name in boundaries) return boundaries[name];
      if (name === "react/jsx-runtime") return jsx;
      throw new Error(`Uncontrolled boundary: ${name} in ${file}`);
    }, ...boundaries.__globals,
  });
  return exports;
}
const locale = load("i18n/locales.ts");
const canonical = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar"];
const flatten = (value, prefix = "", result = {}) => {
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  else result[prefix] = value;
  return result;
};
function treeShape(value) {
  if (Array.isArray(value)) return value.map(treeShape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, treeShape(child)]));
  return typeof value;
}
function duplicateJsonProperties(text) {
  const source = ts.parseJsonText("catalogue.json", text), duplicates = [];
  assert.equal(source.parseDiagnostics.length, 0, "JSON AST syntax");
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const property of node.properties) {
        const key = property.name?.text;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return duplicates;
}
function signature(text) {
  const args = new Set(), tags = new Set();
  const visit = nodes => { for (const node of nodes) {
    if ([1, 2, 3, 4, 5, 6].includes(node.type)) args.add(node.value);
    if (node.type === 8) { tags.add(node.value); visit(node.children); }
    if (node.options) for (const option of Object.values(node.options)) visit(option.value);
  } };
  visit(parse(text));
  return { arguments: [...args].sort(), tags: [...tags].sort() };
}
test("the canonical contract exposes eight locales and only Arabic is RTL", () => {
  assert.deepEqual(Array.from(locale.locales), canonical);
  for (const code of canonical) assert.equal(locale.localeDirection(code), code === "ar" ? "rtl" : "ltr");
});
test("old Spanish cookies and regional tags resolve to supported canonical variants", () => {
  for (const [input, expected] of [["es", "es-419"], ["ES_419", "es-419"], ["es-MX", "es-419"], ["es-ES", "es-419"],
    ["pt", "pt-BR"], ["pt_br", "pt-BR"], ["pt-PT", "pt-BR"], ["en-GB", "en"], ["ja-JP", "ja"], ["ar-EG", "ar"]]) {
    assert.equal(locale.normalizeLocale(input), expected, input);
  }
  for (const invalid of [null, undefined, false, {}, "", " ", "../../en", "en;q=1", "en; Path=/", "xx", "*", "ja-", "x".repeat(100)]) assert.equal(locale.normalizeLocale(invalid), null);
});
test("negotiation respects quality, q=0, stable ties and saved preference", () => {
  assert.equal(locale.resolveLocale("es", "ja-JP, en;q=0.8"), "es-419");
  assert.equal(locale.resolveLocale("unknown", "fr;q=0.2, pt-BR;q=0.9, en;q=0.6"), "pt-BR");
  assert.equal(locale.resolveLocale(null, "ja;q=0, ar;q=0.7, en;q=0.5"), "ar");
  assert.equal(locale.resolveLocale(null, "de;q=0.8, fr;q=0.8"), "de");
  assert.equal(locale.resolveLocale(null, "zh-CN, ja;q=0.8"), "ja");
  assert.equal(locale.resolveLocale(null, "ar;q=invalid, pt;q=2, tr;q=0"), "en");
  assert.equal(locale.resolveLocale(null, null), "en");
});
test("canonical cookies retain preference scope and reject arbitrary strings", () => {
  assert.equal(locale.localeCookie("es", true), "NEXT_LOCALE=es-419; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(locale.localeCookie("pt_BR"), "NEXT_LOCALE=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(locale.localeCookie("en; domain=example.test"), null);
});
test("unknown numbers remain unknown; currency and caller-chosen time zone are preserved", () => {
  for (const value of [null, undefined, "", " ", false, {}, NaN, Infinity, "not-a-number"]) {
    assert.equal(locale.formatNumber(value, "tr"), "—"); assert.equal(locale.formatCurrency(value, "USD", "pt-BR"), "—");
  }
  assert.equal(locale.formatNumber(1234.5, "de"), new Intl.NumberFormat("de").format(1234.5));
  assert.equal(locale.formatCurrency("19", "USD", "pt-BR"), new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format(19));
  assert.equal(locale.formatCurrency(19, "../USD", "ja"), "—");
  assert.equal(locale.formatCurrency(0, "USD", "ja"), new Intl.NumberFormat("ja", { style: "currency", currency: "USD" }).format(0));
  const options = { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }, instant = "2026-10-19T23:40:00Z";
  for (const code of canonical) assert.equal(locale.formatDateTime(instant, code, options), new Intl.DateTimeFormat(code, options).format(new Date(instant)));
  assert.equal(locale.formatDateTime("invalid", "ja", options), "—"); assert.equal(locale.formatDateTime(null, "ar", options), "—");
});
const english = flatten(messages("en"));
for (const code of canonical) test(`${code}: complete catalogue, nonempty strings and ICU argument/tag parity`, () => {
  const translated = flatten(messages(code));
  assert.deepEqual(duplicateJsonProperties(read(`messages/${code}.json`)), []);
  assert.deepEqual(treeShape(messages(code)), treeShape(messages("en")), "objects and raw message arrays retain their shape");
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort());
  for (const [key, text] of Object.entries(translated)) {
    assert.equal(typeof text, "string", `${code}:${key}`); assert.ok(text.trim(), `${code}:${key}:empty`);
    assert.deepEqual(signature(text), signature(english[key]), `${code}:${key}:ICU`);
  }
  for (const option of canonical) assert.ok(messages(code).language[option]);
});
test("legacy es remains compatible while es-419 uses Latin American cost terminology", () => {
  const legacy = flatten(messages("es")), latin = flatten(messages("es-419"));
  assert.deepEqual(Object.keys(legacy).sort(), Object.keys(latin).sort());
  assert.match(latin["features.items.governance.desc"], /costo/); assert.doesNotMatch(latin["features.items.governance.desc"], /\bcoste\b/);
});
test("actual next-intl handles plural branches and new transactional copy in all locales", () => {
  for (const code of canonical) {
    const t = createTranslator({ locale: code, messages: messages(code), onError: error => { throw error; } });
    for (const count of [0, 1, 2, 5, 21, 1.5]) {
      const result = t("app.dashboard.statusStreaming", { count }); assert.equal(typeof result, "string"); assert.ok(result.length > 0);
      assert.doesNotMatch(result, /\{count|\bplural\b|# /);
    }
    for (const key of ["app.exportBundle.plainConfigurationHelp", "static.contact.draftHelp", "auth.register.inferenceFunding"]) assert.notEqual(t(key), key);
    assert.ok(t("publicPreview.individualPeriod", { price: "USD 19" }).includes("USD 19"));
    assert.ok(t("publicPreview.teamPeriod", { price: "USD 39" }).includes("USD 39"));
    assert.ok(t("publicPreview.unavailableLabel", { plan: "Team" }).includes("Team"));
    for (const key of ["individualItems", "teamItems"]) {
      const items = t.raw(`publicPreview.${key}`);
      assert.ok(Array.isArray(items)); assert.equal(items.length, 4);
      assert.ok(items.every(item => typeof item === "string" && item.trim().length > 0));
    }
  }
});
test("actual request loads canonical messages for old cookies and header fallback", async () => {
  for (const [saved, header, expected] of [["es", "en", "es-419"], ["pt_br", "en", "pt-BR"], [null, "ja-JP", "ja"], ["bad", "ar", "ar"]]) {
    const module = load("i18n/request.ts", {
      "next-intl/server": { getRequestConfig: callback => callback },
      "next/headers": { cookies: async () => ({ get: () => saved ? { value: saved } : undefined }), headers: async () => ({ get: () => header }) },
      "./locales": locale, ...Object.fromEntries(canonical.map(code => [`../messages/${code}.json`, messages(code)])),
    });
    const result = await module.default(); assert.equal(result.locale, expected); assert.equal(result.messages.language.label, messages(expected).language.label);
  }
});
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}
test("actual selector writes canonical cookie and refreshes without a full navigation", () => {
  const document = { cookie: "" }, calls = [], window = { location: { protocol: "https:" } };
  const module = load("components/LanguageSwitcher.tsx", {
    react: { useTransition: () => [false, callback => callback()] },
    "next/navigation": { useRouter: () => ({ refresh: () => calls.push("refresh") }) },
    "next-intl": { useLocale: () => "es", useTranslations: () => key => messages("es-419").language[key] },
    "../i18n/locales": locale, __globals: { document, window },
  });
  const select = elements(module.default()).find(node => node.type === "select"); assert.equal(select.props.value, "es-419");
  assert.equal(select.props["aria-label"], messages("es-419").language.label);
  assert.equal(select.props.style.outline, undefined, "the native keyboard focus outline is preserved");
  assert.equal(select.props.style.maxWidth, "min(32vw, 10rem)");
  assert.deepEqual(elements(select).filter(node => node.type === "option").map(node => node.props.value), canonical);
  select.props.onChange({ target: { value: "pt-BR" } }); assert.match(document.cookie, /^NEXT_LOCALE=pt-BR;/); assert.match(document.cookie, /; Secure$/);
  assert.deepEqual(calls, ["refresh"]); select.props.onChange({ target: { value: "invalid" } }); assert.deepEqual(calls, ["refresh"]);
});
test("actual root layout keeps Arabic direction and supplies contact namespaces", async () => {
  const Provider = props => props.children;
  const module = load("app/layout.tsx", {
    "next/headers": { headers: async () => ({ get: key => key === "x-braavolabs-pathname" ? "/contact" : key === "x-braavolabs-surface" ? "public" : null }) },
    "next-intl": { NextIntlClientProvider: Provider }, "next-intl/server": { getLocale: async () => "ar", getMessages: async () => messages("ar") },
    "./AuthLayout": { default: () => { throw new Error("Unexpected private route"); } },
    "../components/CookieConsent": { default: () => null },
    "../components/OptionalAnalytics": { default: () => null }, "../components/SkipLink": { default: () => null },
    "../components/Toast": { ToastProvider: props => props.children }, "../lib/surface-domain": { ...load("lib/surface-domain.ts"), surfaceForHost: () => "public" }, "./globals.css": {},
  });
  const tree = await module.default({ children: React.createElement("main", {}, "fixture") }); assert.equal(tree.props.lang, "ar"); assert.equal(tree.props.dir, "rtl");
  const payload = elements(tree).find(node => node.type === Provider).props.messages;
  for (const key of ["static.contact.topic", "static.contact.draftHelp", "static.changelog.title", "nav.features", "nav.pricing", "nav.signIn", "nav.dashboard", "auth.fields.fullName", "auth.fields.fullNamePlaceholder", "auth.fields.email", "auth.fields.emailPlaceholder", "footer.privacy", "footer.terms"]) assert.equal(typeof flatten(payload)[key], "string", key);
  assert.equal(payload.app, undefined, "public payload excludes private app namespaces");
});
test("public locale controls receive their catalogue on each public route without private namespaces", async () => {
  const Provider = props => props.children;
  for (const code of canonical) for (const pathname of ["/", "/pricing", "/contact", "/privacy"]) {
    const module = load("app/layout.tsx", {
      "next/headers": { headers: async () => ({ get: key => key === "x-braavolabs-pathname" ? pathname : key === "x-braavolabs-surface" ? "public" : null }) },
      "next-intl": { NextIntlClientProvider: Provider },
      "next-intl/server": { getLocale: async () => code, getMessages: async () => messages(code) },
      "./AuthLayout": { default: () => { throw new Error("Unexpected private route"); } },
      "../components/CookieConsent": { default: () => null },
    "../components/OptionalAnalytics": { default: () => null }, "../components/SkipLink": { default: () => null },
      "../components/Toast": { ToastProvider: props => props.children }, "../lib/surface-domain": { ...load("lib/surface-domain.ts"), surfaceForHost: () => "public" }, "./globals.css": {},
    });
    const tree = await module.default({ children: React.createElement("main", {}, "fixture") });
    assert.equal(tree.props.lang, code); assert.equal(tree.props.dir, locale.localeDirection(code));
    const payload = elements(tree).find(node => node.type === Provider).props.messages;
    const t = createTranslator({ locale: code, messages: payload, namespace: "language", onError: error => { throw error; } });
    for (const option of canonical) assert.equal(typeof t(option), "string", `${code}:${pathname}:${option}`);
    assert.equal(payload.app, undefined); assert.equal(payload.publicPreview, undefined, "server-rendered public copy does not inflate the client payload");
  }
});
