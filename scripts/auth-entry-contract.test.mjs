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
// boundaries replaced. No browser, server, session store or network is used.
// Skip-link tests opt into the installed next-intl provider instead of a mock.
function fixture(locale = "en", mode = "login", fetchImpl = () => { throw new Error("Unexpected network"); }, interaction) {
  const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
  const translate = (namespace) => Object.assign((key) => {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    const value = lookup(messages, fullKey);
    assert.equal(typeof value, "string", `${locale}: missing ${fullKey}`);
    return value;
  }, { raw: (key) => lookup(messages, namespace ? `${namespace}.${key}` : key) });
  const store = Object.assign((selector) => selector({ token: null, _hydrated: false, setAuth() { throw new Error("Unexpected auth write"); } }), {
    getState() { throw new Error("Auth endpoint must not touch session storage"); },
  });
  const cache = new Map();
  let stateIndex = 0;
  function load(path) {
    const absolute = resolve(ROOT, path);
    if (cache.has(absolute)) return cache.get(absolute);
    // A failed .ts candidate must not poison a later import of the real .tsx
    // module shared by a page and RootLayout (for example CookieConsent).
    const source = readFileSync(absolute, "utf8");
    const exports = {};
    cache.set(absolute, exports);
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: absolute,
    }).outputText;
    const require = (id) => {
      if (id === "react") return { ...React, useState: (initial) => {
        const index = stateIndex++;
        const [value, setValue] = React.useState(interaction?.initial && Object.hasOwn(interaction.initial, index)
          ? interaction.initial[index] : (initial === "login" ? mode : initial));
        return [value, interaction ? (next) => interaction.updates.push({ index, value: next }) : setValue];
      } };
      if (id === "react/jsx-runtime") {
        const runtime = uiRequire(id);
        const capture = (method) => (type, props, key) => {
          if (interaction && type === "form" && props.noValidate) interaction.submit = props.onSubmit;
          if (interaction?.buttons && type === "button") interaction.buttons.push(props);
          return runtime[method](type, props, key);
        };
        return { ...runtime, jsx: capture("jsx"), jsxs: capture("jsxs") };
      }
      if (id === "next/navigation") return {
        useRouter: () => ({ replace() { throw new Error("Unexpected navigation"); } }),
        usePathname: () => interaction?.pathname ?? "/login",
      };
      if (id === "next-intl") return interaction?.realIntl ? uiRequire(id) : { useTranslations: translate, useLocale: () => locale };
      if (id === "next-intl/server") return {
        getTranslations: async (namespace) => translate(namespace), getLocale: async () => locale, getMessages: async () => messages,
      };
      if (id === "next/headers") return { headers: async () => new Headers(interaction?.headers) };
      if (id === "next/link") return { __esModule: true, default: (props) => React.createElement("a", props) };
      if (id.endsWith(".css")) return {};
      if (absolute.endsWith("/app/layout.tsx") && id === "../components/Toast") return {
        ToastProvider: ({ children }) => React.createElement(React.Fragment, null, children),
      };
      if (id.endsWith("/store")) return { useAppStore: store };
      if (absolute.endsWith("/app/AuthLayout.tsx") && [
        "../components/Sidebar", "../components/CommandPalette", "../components/NotificationBell",
        "../components/OnboardingChecklist", "../components/Breadcrumb", "../components/PresenceBar",
      ].includes(id)) return { __esModule: true, default: () => null };
      if (id.startsWith(".")) {
        const target = resolve(dirname(absolute), id);
        for (const extension of [".ts", ".tsx"]) {
          try { return load(target + extension); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      throw new Error(`Unexpected import: ${id}`);
    };
    vm.runInNewContext(output, { exports, require, process: { env: {} }, fetch: fetchImpl, Response, Error, console, window: interaction?.window }, { filename: absolute });
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

test("auth submit does not inherit the opacity-zero stagger animation", () => {
  for (const mode of ["login", "register"]) {
    const { load } = fixture("en", mode);
    const html = renderToStaticMarkup(React.createElement(load("packages/ui/app/login/page.tsx").default));
    const form = html.match(/<form\b[^>]*>/)?.[0];
    assert.ok(form, "the actual auth form must render");
    assert.doesNotMatch(form, /bv-stagger/, "primary gradient overrides stagger fade and leaves opacity zero");
    assert.match(html, /class="[^"]*\bbv-auth-entry\b/);
    assert.match(html, /<button[^>]*type="submit"[^>]*bv-btn-primary/);
  }
});

function skipLinkDeclarations(selector) {
  const css = read("packages/ui/app/globals.css");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) =>
    selectors.split(",").some((value) => value.trim().replace(/\/\*[\s\S]*?\*\//g, "").trim() === selector),
  );
  assert.ok(rule, `${selector} must remain in the actual stylesheet`);
  return Object.fromEntries(rule[2].split(";").filter((value) => value.trim()).map((value) => {
    const colon = value.indexOf(":");
    return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
}

test("skip link stays clipped inside the viewport without inaccessible or off-canvas hiding", () => {
  const declarations = skipLinkDeclarations(".skip-link");
  assert.ok(!Object.values(declarations).some((value) => /-9999/.test(value)), "off-canvas hiding expands RTL document width");
  for (const [property, value] of Object.entries({
    position: "absolute", "inset-inline-start": "8px", "inset-block-start": "8px",
    width: "1px", height: "1px", padding: "0", margin: "-1px", overflow: "hidden",
    clip: "rect(0, 0, 0, 0)", "clip-path": "inset(50%)", "white-space": "nowrap",
  })) assert.equal(declarations[property], value, property);
  assert.notEqual(declarations.display, "none");
  assert.notEqual(declarations.visibility, "hidden");
  assert.notEqual(declarations.opacity, "0");
});

test("skip link restores visible geometry and clipping for keyboard focus", () => {
  for (const selector of [".skip-link:focus", ".skip-link:focus-visible"]) {
    const declarations = skipLinkDeclarations(selector);
    for (const [property, value] of Object.entries({
      "inset-inline-start": "8px", "inset-block-start": "8px", width: "auto", height: "auto",
      padding: "8px 16px", margin: "0", overflow: "visible", clip: "auto", "clip-path": "none", "white-space": "normal",
    })) assert.equal(declarations[property], value, `${selector} ${property}`);
  }
});

test("skip link has one focusable actual auth main target before and after hydration", () => {
  assert.match(read("packages/ui/components/SkipLink.tsx"), /<a href="#main-content" className="skip-link">/);
  for (const hydrated of [false, true]) {
    for (const pathname of ["/login", "/register"]) {
      const mode = pathname === "/login" ? "login" : "register";
      const { load } = fixture("en", mode, undefined, { initial: { 0: hydrated }, updates: [], pathname });
      const AuthLayout = load("packages/ui/app/AuthLayout.tsx").default;
      const Page = load("packages/ui/app/login/page.tsx").default;
      const html = renderToStaticMarkup(React.createElement(AuthLayout, null, React.createElement(Page)));
      assert.equal([...html.matchAll(/id="main-content"/g)].length, 1, `${pathname} hydrated=${hydrated}`);
      assert.match(html, /<main\b[^>]*id="main-content"[^>]*tabindex="-1"/);
    }
  }
});

const SKIP_LABELS = {
  en: "Skip to main content", tr: "Ana içeriğe geç", es: "Ir al contenido principal",
  de: "Zum Hauptinhalt springen", fr: "Aller au contenu principal", ar: "انتقل إلى المحتوى الرئيسي",
};

const LEGAL_CHROME_KEYS = ["legal", "openApp", "privacy", "terms", "cookies", "accountDeletion", "onThisPage", "permalinkTo"];
const LEGAL_CHROME = Object.fromEntries(Object.entries({
  en: ["Legal", "Open app", "Privacy", "Terms", "Cookies", "Account deletion", "On this page", "Permalink to {title}"],
  tr: ["Yasal", "Uygulamayı aç", "Gizlilik", "Şartlar", "Çerezler", "Hesap silme", "Bu sayfada", "{title} bölümüne kalıcı bağlantı"],
  es: ["Información legal", "Abrir la aplicación", "Privacidad", "Términos", "Cookies", "Eliminación de la cuenta", "En esta página", "Enlace permanente a {title}"],
  de: ["Rechtliches", "App öffnen", "Datenschutz", "AGB", "Cookies", "Kontolöschung", "Auf dieser Seite", "Permanenter Link zu {title}"],
  fr: ["Informations juridiques", "Ouvrir l’application", "Confidentialité", "Conditions", "Cookies", "Suppression du compte", "Sur cette page", "Lien permanent vers {title}"],
  ar: ["المعلومات القانونية", "فتح التطبيق", "الخصوصية", "الشروط", "ملفات تعريف الارتباط", "حذف الحساب", "في هذه الصفحة", "رابط دائم إلى {title}"],
}).map(([locale, values]) => [locale, Object.fromEntries(LEGAL_CHROME_KEYS.map((key, index) => [key, values[index]]))]));
const escapedText = (text) => renderToStaticMarkup(React.createElement("span", null, text)).slice(6, -7);
const anchorsIn = (html) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, content]) => ({
  href: attributes.match(/\bhref="([^"]+)"/)?.[1], content: content.trim(), attributes,
}));

test("legal layout hooks belong only to their actual TSX owners", async () => {
  for (const locale of LOCALES) {
    for (const route of ["privacy", "cookies", "kvkk"]) {
      const { load } = fixture(locale, "login", undefined, {
        realIntl: true, headers: {
          host: "www.braavolabs.com", "x-braavolabs-surface": "public",
          "x-braavolabs-pathname": "/" + route,
        },
      });
      const Page = load("packages/ui/app/" + route + "/page.tsx").default;
      const layout = await load("packages/ui/app/layout.tsx").default({ children: React.createElement(Page) });
      const html = renderToStaticMarkup(React.createElement(uiRequire("next-intl").NextIntlClientProvider,
        { locale, timeZone: "UTC", onError: (error) => { throw error; } }, layout));
      const appLinks = anchorsIn(html).filter((anchor) => anchor.href === "https://app.braavolabs.com");
      assert.equal(appLinks.length, 1, locale + "/" + route + ": exact existing app anchor");
      assert.equal(/\bbv-legal-cta\b/.test(appLinks[0].attributes), route !== "cookies",
        locale + "/" + route + ": legal decoration scope");
      if (route === "privacy") {
        const nav = html.match(/<nav\b[^>]*class="[^"]*\bbv-privacy-nav\b[^"]*"[^>]*>/)?.[0];
        assert.ok(nav, "actual privacy navbar owns the mobile reflow hook");
        const inlineStyle = nav.match(/\bstyle="([^"]*)"/)?.[1] ?? "";
        assert.doesNotMatch(inlineStyle, /(?:^|;)height:/, "scoped CSS owns desktop/mobile height");
        assert.match(html, /<div\b[^>]*class="[^"]*\bbv-privacy-nav-actions\b/);
        assert.match(html, /<h1\b[^>]*class="[^"]*\bbv-privacy-title\b/);
      } else {
        assert.doesNotMatch(html, /\bbv-privacy-/);
      }
    }
    for (const mode of ["login", "register"]) {
      const { load } = fixture(locale, mode);
      const html = renderToStaticMarkup(React.createElement(load("packages/ui/app/login/page.tsx").default));
      assert.doesNotMatch(html, /\bbv-legal-cta\b|\bbv-privacy-/,
        locale + "/" + mode + ": legal hooks must not affect auth");
    }
  }
});

// These selectors contain only class names and an optional ::before suffix.
// Read actual CSS declarations; browser geometry remains a separate hosted gate.
const legalCssRule = (css, selector) => {
  const escaped = selector.replaceAll(".", "\\.");
  const match = css.match(new RegExp(escaped + "\\s*\\{([^{}]*)\\}"));
  assert.ok(match, "missing actual CSS rule " + selector);
  return match[1];
};

test("privacy mobile layout reflows without clipping or truncation", () => {
  const css = read("packages/ui/app/globals.css");
  const mobile = [...css.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/g)]
    .map((match) => match[1]).find((body) => body.includes(".bv-privacy-nav"));
  assert.ok(mobile, "privacy needs its own narrow-layout rules");
  assert.match(legalCssRule(css, ".bv-privacy-nav"), /height:\s*64px\s*;/);
  const nav = legalCssRule(mobile, ".bv-privacy-nav");
  assert.match(nav, /height:\s*auto\s*;/);
  assert.match(nav, /min-height:\s*64px\s*;/);
  assert.match(nav, /flex-wrap:\s*wrap\s*;/);
  assert.match(nav, /padding-block:\s*12px\s*;/);
  const actions = legalCssRule(mobile, ".bv-privacy-nav-actions");
  assert.match(actions, /flex-wrap:\s*wrap\s*;/);
  assert.match(actions, /min-width:\s*0\s*;/);
  assert.match(actions, /max-width:\s*100%\s*;/);
  assert.match(actions, /margin-inline-start:\s*auto\s*;/);
  assert.match(legalCssRule(mobile, ".bv-privacy-title"), /overflow-wrap:\s*anywhere\s*;/);
  assert.doesNotMatch(mobile, /overflow(?:-x)?:\s*(?:hidden|clip)|text-overflow:\s*ellipsis/);
  const selectors = [...mobile.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());
  assert.deepEqual(selectors, [".bv-privacy-nav", ".bv-privacy-nav-actions", ".bv-privacy-title"]);
});

test("legal sheen moves paint within its stationary scoped box", () => {
  const css = read("packages/ui/app/globals.css");
  const pseudo = legalCssRule(css, ".bv-legal-cta.bv-btn-primary::before");
  assert.match(pseudo, /transform:\s*none\s*;/);
  assert.match(pseudo, /animation:\s*bv-legal-sheen\s+8s\s+ease-in-out\s+infinite\s*;/);
  assert.match(pseudo, /background-size:\s*300%\s+100%\s*;/);
  assert.match(pseudo, /background-repeat:\s*no-repeat\s*;/);
  const frames = css.match(/@keyframes bv-legal-sheen\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(frames, "bounded legal sheen owns its keyframes");
  assert.match(frames, /0%,\s*80%\s*\{\s*background-position:\s*150%\s+0;\s*\}/);
  assert.match(frames, /90%,\s*100%\s*\{\s*background-position:\s*-50%\s+0;\s*\}/);
  assert.doesNotMatch(frames, /transform|translate|\binset\s*:|\b(?:left|right|width|height)\s*:/);
  const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.bv-legal-cta([\s\S]*?)\n\}/)?.[0];
  assert.ok(reduced, "legal controls have a separate reduced-motion scope");
  assert.match(legalCssRule(reduced, ".bv-legal-cta.bv-btn-primary"), /animation:\s*none\s*;/);
  const reducedPseudo = legalCssRule(reduced, ".bv-legal-cta.bv-btn-primary::before");
  assert.match(reducedPseudo, /content:\s*none\s*;/);
  assert.match(reducedPseudo, /animation:\s*none\s*;/);
  assert.match(reducedPseudo, /transform:\s*none\s*;/);
  const selectors = [...reduced.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());
  assert.deepEqual(selectors, [".bv-legal-cta.bv-btn-primary", ".bv-legal-cta.bv-btn-primary::before"]);
});

for (const locale of LOCALES) {
  test(`${locale}: legal chrome has exactly the approved eight translations and ICU title argument`, () => {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    assert.deepEqual(messages.static.common.legalNavigation, LEGAL_CHROME[locale]);
    assert.equal(messages.static.common.legalNavigation.privacy, messages.footer.privacy);
    assert.equal(messages.static.common.legalNavigation.terms, messages.footer.terms);
    assert.equal(messages.static.common.legalNavigation.permalinkTo.match(/\{title\}/g)?.length, 1);
  });

  for (const route of ["privacy", "cookies", "kvkk"]) {
    test(`legal chrome ${locale}/${route}: real public SSR/pruning translates navigation and ICU names`, async () => {
      const { load, messages } = fixture(locale, "login", undefined, {
        realIntl: true, headers: { host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": `/${route}` },
      });
      const Page = load(`packages/ui/app/${route}/page.tsx`).default;
      const layout = await load("packages/ui/app/layout.tsx").default({ children: React.createElement(Page) });
      // The actual inner provider must supply its pruned route/common values;
      // the outer context supplies only the ambient server timezone.
      const html = renderToStaticMarkup(React.createElement(uiRequire("next-intl").NextIntlClientProvider,
        { locale, timeZone: "UTC", onError: (error) => { throw error; } }, layout));
      const copy = LEGAL_CHROME[locale];
      const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
      assert.ok(header, "actual page header must render");
      assert.ok(header.includes(escapedText(copy.legal)), `${locale}/${route}: legal eyebrow`);
      assert.equal(anchorsIn(html).find((anchor) => anchor.href === "https://app.braavolabs.com")?.content, escapedText(copy.openApp));
      assert.deepEqual(anchorsIn(header).map(({ href, content }) => [href, content]), [
        ["/privacy", copy.privacy], ["/terms", copy.terms], ["/cookies", copy.cookies],
        ["/gdpr", "GDPR"], ["/kvkk", "KVKK"], ["/legal/account-deletion", copy.accountDeletion],
      ].map(([href, label]) => [href, escapedText(label)]));
      const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
      assert.ok(main?.includes(escapedText(copy.onThisPage)), `${locale}/${route}: visible TOC label`);
      if (route !== "kvkk") assert.ok(main.includes(`aria-label="${escapedText(copy.onThisPage)}"`));
      const title = route === "kvkk" ? "Veri Sorumlusu" : messages.static.legal[route].sections[0].title;
      const expectedPermalink = escapedText(copy.permalinkTo.replace("{title}", title));
      assert.ok(main.includes(`aria-label="${expectedPermalink}"`), `${locale}/${route}: real ICU title interpolation`);
      assert.doesNotMatch(html, /static\.common\.legalNavigation\.|\{title\}/);
      assert.equal([...html.matchAll(/id="main-content"/g)].length, 1);
      assert.match(html, /<main\b[^>]*id="main-content"[^>]*tabindex="-1"/);
      if (route === "kvkk") {
        const footer = html.slice(html.indexOf("<footer"));
        assert.ok(footer.includes(escapedText(copy.legal)), `${locale}: KVKK legal footer heading`);
        for (const key of ["privacy", "terms"]) {
          assert.equal(anchorsIn(footer).find((anchor) => anchor.href === `/${key}`)?.content, escapedText(copy[key]));
        }
      }
    });
  }
}

test("skip link consumes current real provider values without a wrapper or cached locale", () => {
  const { NextIntlClientProvider } = uiRequire("next-intl");
  const { load } = fixture("tr", "login", undefined, { realIntl: true });
  const SkipLink = load("packages/ui/components/SkipLink.tsx").default;
  assert.match(read("packages/ui/components/SkipLink.tsx"), /^"use client";/);
  // Reuse one component element across provider value changes. This proves
  // context-driven SSR; the hosted selector test proves the completed reload.
  const child = React.createElement(SkipLink);
  for (const locale of ["tr", "ar", "en", "es", "de", "fr", "tr"]) {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    assert.equal(messages.static.common.skipToMainContent, SKIP_LABELS[locale]);
    const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale, messages, timeZone: "UTC", onError: (error) => { throw error; } }, child));
    assert.equal(html, `<a href="#main-content" class="skip-link">${SKIP_LABELS[locale]}</a>`);
  }
  const changedMessages = { static: { common: { skipToMainContent: SKIP_LABELS.ar } } };
  assert.equal(renderToStaticMarkup(React.createElement(NextIntlClientProvider,
    { locale: "tr", messages: changedMessages, timeZone: "UTC" }, child)),
  `<a href="#main-content" class="skip-link">${SKIP_LABELS.ar}</a>`, "message changes must not use a cached locale lookup");
});

test("the existing intl provider owns the first body keyboard stop and retains public common messages", async () => {
  const source = read("packages/ui/app/layout.tsx");
  assert.doesNotMatch(source, /Skip to main content/);
  assert.match(source, /<NextIntlClientProvider locale=\{locale\} messages=\{providerMessages\}>\s*<SkipLink \/>\s*<ToastProvider>/);
  for (const locale of LOCALES) {
    for (const pathname of ["/privacy", "/cookies", "/kvkk"]) {
      const { load, messages } = fixture(locale, "login", undefined, {
        realIntl: true, headers: { host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": pathname },
      });
      const layout = await load("packages/ui/app/layout.tsx").default({ children: React.createElement("main", { id: "main-content" }, "legal fixture") });
      // Supply the request's ambient timezone, normally inherited from Next's
      // server configuration. The actual inner provider still prunes messages.
      const html = renderToStaticMarkup(React.createElement(uiRequire("next-intl").NextIntlClientProvider,
        { locale, messages, timeZone: "UTC", onError: (error) => { throw error; } }, layout));
      assert.match(html, new RegExp(`<html[^>]*lang="${locale}"`));
      assert.ok(html.includes(`<a href="#main-content" class="skip-link">${SKIP_LABELS[locale]}</a>`));
      assert.match(html, /<body[^>]*><a href="#main-content" class="skip-link">/);
    }
  }
});

for (const route of ["privacy", "cookies", "kvkk"]) {
  test(`${route}: actual legal content has exactly one focusable main in all six locales`, () => {
    for (const locale of LOCALES) {
      const { load } = fixture(locale);
      const html = renderToStaticMarkup(React.createElement(load(`packages/ui/app/${route}/page.tsx`).default));
      assert.equal([...html.matchAll(/<main\b/g)].length, 1, `${route} ${locale}: main landmark`);
      assert.equal([...html.matchAll(/id="main-content"/g)].length, 1, `${route} ${locale}: unique target`);
      assert.match(html, /<main\b[^>]*id="main-content"[^>]*tabindex="-1"/);
      assert.match(html, /<main\b[\s\S]*<h2\b[\s\S]*<\/main>/, "target contains the actual legal content, not an empty marker");
    }
  });
}

test("all five consent legal links are ordinary anchors with unchanged destinations, labels and styling", () => {
  const source = read("packages/ui/components/CookieConsent.tsx");
  assert.doesNotMatch(source, /from "next\/link"/);
  assert.equal([...source.matchAll(/<a href="\/(privacy|cookies|kvkk)"/g)].length, 5);
  for (const [locale, expected] of Object.entries({
    en: [["/privacy", "Privacy Policy"], ["/cookies", "Cookie Policy"]],
    tr: [["/privacy", "Gizlilik Politikası"], ["/cookies", "Çerez Politikası"], ["/kvkk", "KVKK"]],
  })) {
    const { load } = fixture(locale, "login", undefined, { initial: { 0: null, 1: locale }, updates: [] });
    const html = renderToStaticMarkup(React.createElement(load("packages/ui/components/CookieConsent.tsx").default));
    const links = [...html.matchAll(/<a href="([^"]+)" style="([^"]+)">([^<]+)<\/a>/g)];
    assert.deepEqual(links.map(([, href, , text]) => [href, text]), expected);
    for (const [, , style] of links) assert.equal(style, "color:#a4e6ff;text-decoration:underline");
    assert.match(html, new RegExp(`role="dialog"[^>]*lang="${locale}"`));
  }
});

test("consent visibility and both existing choices remain unchanged", () => {
  for (const consent of ["loading", "accepted", "essential-only"]) {
    const { load } = fixture("en", "login", undefined, { initial: { 0: consent }, updates: [] });
    assert.equal(renderToStaticMarkup(React.createElement(load("packages/ui/components/CookieConsent.tsx").default)), "");
  }
  for (const locale of ["en", "tr"]) {
    for (const [index, choice] of ["essential-only", "accepted"].entries()) {
      const writes = [];
      const interaction = { initial: { 0: null, 1: locale }, updates: [], buttons: [],
        window: { localStorage: { setItem: (...args) => writes.push(args) } } };
      const { load } = fixture(locale, "login", undefined, interaction);
      renderToStaticMarkup(React.createElement(load("packages/ui/components/CookieConsent.tsx").default));
      assert.equal(interaction.buttons.length, 2);
      interaction.buttons[index].onClick();
      assert.deepEqual(writes, [["cookie_consent", choice]]);
      assert.deepEqual(interaction.updates, [{ index: 0, value: choice }]);
    }
  }
});

test("skip link preserves the existing terms child target without a duplicate outer id", () => {
  assert.match(read("packages/ui/app/terms/page.tsx"), /<main\s+id="main-content"/);
  for (const hydrated of [false, true]) {
    const { load } = fixture("en", "login", undefined, { initial: { 0: hydrated }, updates: [], pathname: "/terms" });
    const AuthLayout = load("packages/ui/app/AuthLayout.tsx").default;
    const html = renderToStaticMarkup(React.createElement(AuthLayout, null,
      React.createElement("main", { id: "main-content" }, "Existing terms child target"),
    ));
    assert.equal([...html.matchAll(/id="main-content"/g)].length, 1, `terms hydrated=${hydrated}`);
    assert.doesNotMatch(html.match(/<main\b[^>]*>/)?.[0] ?? "", /id="main-content"/);
  }
});

test("reduced-motion auth styles stop entrance and decorative animations without changing other surfaces", () => {
  const css = read("packages/ui/app/globals.css");
  const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(media, "auth needs an explicit reduced-motion rule");
  const rules = [...media.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarations = new Map();
  for (const [, selectors, body] of rules) {
    for (const selector of selectors.split(",").map(value => value.trim())) {
      assert.ok(selector.startsWith(".bv-auth-entry "), `out-of-scope reduced motion: ${selector}`);
      declarations.set(selector, body);
    }
  }
  assert.deepEqual([...declarations.keys()].sort(), [
    ".bv-auth-entry .bv-btn-primary", ".bv-auth-entry .bv-btn-primary::before", ".bv-auth-entry .bv-rise",
  ]);
  for (const selector of [".bv-auth-entry .bv-rise", ".bv-auth-entry .bv-btn-primary"]) {
    assert.match(declarations.get(selector), /animation:\s*none\s*;/);
    assert.match(declarations.get(selector), /opacity:\s*1\s*;/);
    assert.match(declarations.get(selector), /transform:\s*none\s*;/);
  }
  assert.match(declarations.get(".bv-auth-entry .bv-btn-primary::before"), /content:\s*none\s*;/);
  assert.match(declarations.get(".bv-auth-entry .bv-btn-primary::before"), /animation:\s*none\s*;/);
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
