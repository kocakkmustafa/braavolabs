import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const { resolveTitle } = uiRequire("next/dist/lib/metadata/resolvers/resolve-title");
const LOCALES = ["en", "tr", "es", "de", "fr", "ar"];
// The language selector offers the full supported set from the i18n source.
const SUPPORTED_LOCALES = JSON.parse(readFileSync(resolve(ROOT, "packages/ui/i18n/locales.ts"), "utf8")
  .match(/export const locales = (\[[^\]]+\]) as const;/)[1]);
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
    // Root-layout appearance chrome keeps real React state so the interaction
    // fixture's state indices remain the page's own, as before the bar existed.
    const layoutChrome = /\/components\/(?:ThemeProvider|ThemeSelector|LanguageSwitcher)\.tsx$/.test(absolute);
    const require = (id) => {
      if (id === "react" && layoutChrome) return React;
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
          const node = runtime[method](type, props, key);
          if (interaction?.nodes && typeof type === "string") interaction.nodes.push(node);
          return node;
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
      if (id.endsWith("/store")) return {
        useAppStore: store,
        captureAuthSession: () => ({ revision: 0, tenantId: null, token: null, refreshToken: null }),
        isAuthSessionCurrent: () => true,
        refreshAuthSession() { throw new Error("Anonymous auth must not refresh session storage"); },
      };
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
    vm.runInNewContext(output, {
      exports, require, process: { env: {} }, fetch: fetchImpl, Response, URL, Error, console, window: interaction?.window,
      // Request deadlines and locale headers use these platform globals.
      Headers, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
    }, { filename: absolute });
    return exports;
  }
  return { load, messages };
}

// Independent expectations freeze the existing non-title metadata contract.
// Only the deletion description intentionally reuses its original OG copy.
const LEGAL_METADATA = {
  privacy: {
    title: "Privacy Policy",
    description: "The published Braavolabs privacy policy and its current data-handling disclosures.",
    ogDescription: "The published Braavolabs privacy policy and its current data-handling disclosures.",
    robots: { index: true, follow: true },
  },
  cookies: {
    title: "Cookie Policy",
    description: "Braavolabs cookie policy: what cookies we use, why we use them, and how to manage or withdraw your consent at any time.",
    ogDescription: "What cookies Braavolabs uses, why, and how to manage or withdraw your consent at any time.",
  },
  terms: {
    title: "Terms of Service",
    description: "Braavolabs Terms of Service. Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
    ogDescription: "Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
    robots: { index: true, follow: true },
  },
  // 0f6a05e reframed GDPR as an explicitly incomplete preview (no completed-notice claim).
  gdpr: {
    title: "GDPR information preview",
    description: "Draft privacy information under GDPR. Responsible-operator, processing, recipient, retention and safeguard details still require completion before public registration.",
    ogTitle: "Braavolabs GDPR information preview",
    ogDescription: "A preview of GDPR processing information and rights; this is not yet the complete notice for public personal-data collection.",
  },
  // Likewise KVKK: an explicitly incomplete preview, localized like GDPR.
  kvkk: {
    title: "KVKK information preview",
    description: "Draft information under KVKK. Actual operator, processing, recipients, retention and safeguards still require completion before public registration.",
    ogTitle: "Braavolabs KVKK information preview",
    ogDescription: "A preview of KVKK processing information and rights; this is not yet a complete privacy notice.",
  },
  "legal/account-deletion": {
    title: "Account Deletion",
    description: "How to permanently delete your Braavolabs account, what data is removed, and how to request assistance.",
    ogTitle: "Braavolabs Account Deletion",
    ogDescription: "How to permanently delete your Braavolabs account, what data is removed, and how to request assistance.",
  },
};
const TRANSLATED_LEGAL_ROUTES = ["privacy", "cookies", "terms"];
// These routes' metadata comes from the seo catalog: the English contract above
// selects the key, and each locale must render that same key's translation.
const SEO_LEGAL_ROUTES = ["gdpr", "kvkk", "legal/account-deletion"];
function seoTranslation(messages, english) {
  const seo = JSON.parse(read("packages/ui/messages/en.json")).seo;
  const keys = Object.keys(seo).filter((key) => seo[key] === english);
  assert.equal(keys.length, 1, `one seo key for ${english}`);
  assert.equal(typeof messages.seo[keys[0]], "string");
  return messages.seo[keys[0]];
}

async function actualLegalMetadata(locale, route) {
  const { load, messages } = fixture(locale, "login", undefined, {
    headers: { host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": `/${route}` },
  });
  const layout = load(`packages/ui/app/${route}/layout.tsx`);
  // The RED baseline has static exports; GREEN evaluates real generators.
  const metadata = layout.generateMetadata ? await layout.generateMetadata() : layout.metadata;
  assert.ok(metadata && typeof metadata === "object", `${route}: metadata export missing`);
  const rootMetadata = await load("packages/ui/app/layout.tsx").generateMetadata();
  assert.equal(rootMetadata.title.template, "%s | Braavolabs");
  return { metadata, messages, template: rootMetadata.title.template };
}

function assertSingleBrandTitle(metadata, template, expected) {
  const actual = resolveTitle(metadata.title, template).absolute;
  assert.equal(actual, `${expected} | Braavolabs`);
  assert.equal((actual.match(/\bBraavolabs\b/g) ?? []).length, 1);
}

for (const locale of LOCALES) {
  for (const route of TRANSLATED_LEGAL_ROUTES) {
    test(`legal metadata ${locale}/${route}: real title and OG title use the existing translation`, async () => {
      const { metadata, messages, template } = await actualLegalMetadata(locale, route);
      const expected = messages.static.legal[route].title;
      assert.equal(metadata.title, expected);
      assert.equal(metadata.openGraph.title, expected);
      assertSingleBrandTitle(metadata, template, expected);
    });
  }
}

for (const [route, expected] of Object.entries(LEGAL_METADATA)) {
  test(`legal metadata ${route}: actual root template adds the brand exactly once`, async () => {
    for (const locale of LOCALES) {
      const { metadata, messages, template } = await actualLegalMetadata(locale, route);
      const localized = (english) => SEO_LEGAL_ROUTES.includes(route) ? seoTranslation(messages, english) : english;
      const title = TRANSLATED_LEGAL_ROUTES.includes(route) ? messages.static.legal[route].title : localized(expected.title);
      assertSingleBrandTitle(metadata, template, title);
      if (expected.ogTitle) assert.equal(metadata.openGraph.title, localized(expected.ogTitle));
    }
  });

  test(`legal metadata ${route}: canonical, robots, descriptions and OG image remain unchanged`, async () => {
    const { metadata } = await actualLegalMetadata("en", route);
    const actual = JSON.parse(JSON.stringify(metadata));
    delete actual.title;
    delete actual.openGraph.title;
    assert.deepEqual(actual, {
      description: expected.description,
      ...(expected.robots ? { robots: expected.robots } : {}),
      alternates: { canonical: `https://www.braavolabs.com/${route}` },
      openGraph: {
        description: expected.ogDescription,
        url: `https://www.braavolabs.com/${route}`,
        images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
      },
    });
  });
}

test("legal metadata account deletion: standard description reuses the existing narrower OG wording", async () => {
  const { metadata } = await actualLegalMetadata("en", "legal/account-deletion");
  assert.equal(metadata.description, LEGAL_METADATA["legal/account-deletion"].ogDescription);
  assert.equal(metadata.description, metadata.openGraph.description);
  assert.doesNotMatch(`${metadata.description}\n${metadata.openGraph.description}`, /all associated data|retention periods after deletion/i);
});

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
      // Language choice is the root layout's appearance bar (one per page); the form
      // card no longer repeats it.
      assert.doesNotMatch(html, /<select/, `${locale} ${mode}: no page-owned language selector`);
      const switcher = renderToStaticMarkup(React.createElement(load("packages/ui/components/LanguageSwitcher.tsx").default));
      for (const language of SUPPORTED_LOCALES) assert.ok(switcher.includes(`value="${language}"`), `${language} offered`);
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

const SSO_MATURITY_LABELS = {
  en: "Organization SSO — in development →",
  tr: "Kurumsal SSO — geliştirme aşamasında →",
  es: "SSO empresarial — en desarrollo →",
  de: "Organisations-SSO — in Entwicklung →",
  fr: "SSO d’entreprise — en développement →",
  ar: "SSO للمؤسسات — قيد التطوير ←",
};

for (const locale of LOCALES) {
  for (const mode of ["login", "register"]) {
    test(`${locale} ${mode}: rendered SSO entry discloses development status`, () => {
      const { load } = fixture(locale, mode);
      const html = renderToStaticMarkup(React.createElement(load("packages/ui/app/login/page.tsx").default));
      const summaries = [...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)];
      assert.equal(summaries.length, 1, "the actual SSO disclosure must render once");
      const expected = renderToStaticMarkup(React.createElement("span", null, SSO_MATURITY_LABELS[locale])).slice(6, -7);
      assert.equal(summaries[0][1], expected);
    });
  }
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
      if (route === "privacy" || route === "cookies") {
        // Both pages own a standalone navbar; long translations must reflow on narrow screens.
        const nav = html.match(/<nav\b[^>]*class="[^"]*\bbv-privacy-nav\b[^"]*"[^>]*>/)?.[0];
        assert.ok(nav, locale + "/" + route + ": actual navbar owns the mobile reflow hook");
        const inlineStyle = nav.match(/\bstyle="([^"]*)"/)?.[1] ?? "";
        assert.doesNotMatch(inlineStyle, /(?:^|;)height:/, "scoped CSS owns desktop/mobile height");
        assert.match(html, /<div\b[^>]*class="[^"]*\bbv-privacy-nav-actions\b/);
        if (route === "privacy") assert.match(html, /<h1\b[^>]*class="[^"]*\bbv-privacy-title\b/);
        else assert.doesNotMatch(html, /\bbv-privacy-title\b/);
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
const PUBLIC_MESSAGE_MANIFEST = JSON.parse(
  read("packages/ui/lib/public-message-manifest.generated.ts").match(/= (\{[\s\S]*\});\s*$/)[1]);
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
      // KVKK is now localized from surface.legal.kvkk; its first section is the responsible operator.
      const title = route === "kvkk" ? messages.surface.legal.kvkk["veri-sorumlusu"].title : messages.static.legal[route].sections[0].title;
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
  // ThemeProvider renders no DOM, so the skip link is still the first body stop.
  assert.match(source, /<NextIntlClientProvider locale=\{locale\} messages=\{providerMessages\}>\s*<ThemeProvider>\s*<SkipLink \/>\s*<ToastProvider>/);
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

// The public document serializes its client message payload into the HTML.
// Authenticated-only copy (trial, starters, plan badges) lives under `app`,
// which never ships publicly; keep every public payload free of retired claims.
const PUBLIC_PAYLOAD_CLAIMS = [/\bFree\b/i, /\bCreator\b/, /\bPro\b/, /\bBusiness\b/, /\bEnterprise\b/, /\btrial\b/i,
  /\bon-device\b/i, /\bfully (?:offline|replayable|[- ]audited)\b/i, /\bair[ -]?gapped\b/i, /\b\d+\s+providers?\b/i,
  /\bend[ -]to[ -]end encrypt(?:ed|ion)\b/i, /\bcloud[ -]blind(?:ness)?\b/i, /\$39\/user\/month\b/];
test("public client message payloads carry no retired or unsupported claims", async () => {
  const values = (node) => typeof node === "string" ? [node] : node && typeof node === "object" ? Object.values(node).flatMap(values) : [];
  for (const pathname of ["/", "/pricing", "/features", "/terms", "/privacy", "/cookies", "/gdpr", "/kvkk",
    "/legal/account-deletion", "/contact", "/about", "/changelog", "/blog", "/status", "/docs"]) {
    const { load } = fixture("en", "login", undefined, {
      realIntl: true, headers: { host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": pathname },
    });
    const layout = await load("packages/ui/app/layout.tsx").default({ children: null });
    const provider = navOne(navElements(layout, (n) => n.props.messages !== undefined), `${pathname}: one pruned provider`);
    assert.equal(provider.props.messages.app, undefined, `${pathname}: authenticated app copy never ships publicly`);
    const findings = values(provider.props.messages).flatMap((value) =>
      PUBLIC_PAYLOAD_CLAIMS.filter((claim) => claim.test(value)).map((claim) => `${claim}: ${value.slice(0, 80)}`));
    assert.deepEqual(findings, [], `${pathname}: public payload claims`);
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

test("both consent legal links are ordinary anchors with localized labels and theme-aware styling", () => {
  // One localized banner for every locale (93614f2): Privacy and Cookie Policy.
  const source = read("packages/ui/components/CookieConsent.tsx");
  assert.doesNotMatch(source, /from "next\/link"/);
  assert.equal([...source.matchAll(/<a href="\/(privacy|cookies|kvkk)"/g)].length, 2);
  for (const locale of LOCALES) {
    const { load, messages } = fixture(locale, "login", undefined, { initial: { 0: null }, updates: [] });
    const labels = messages.static.cookieConsent;
    const html = renderToStaticMarkup(React.createElement(load("packages/ui/components/CookieConsent.tsx").default));
    const links = [...html.matchAll(/<a href="([^"]+)" style="([^"]+)">([^<]+)<\/a>/g)];
    const text = (value) => renderToStaticMarkup(React.createElement("span", null, value)).slice(6, -7);
    assert.deepEqual(links.map(([, href, , label]) => [href, label]),
      [["/privacy", text(labels.privacyLabel)], ["/cookies", text(labels.cookiesLabel)]]);
    for (const [, , style] of links) assert.equal(style, "color:var(--color-info);text-decoration:underline");
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
      for (const persists of [true, false]) {
        // The choice is verified by read-back; a write that does not persist
        // reports failure and never grants analytics in this document.
        const writes = [], stored = new Map();
        const interaction = { initial: { 0: null }, updates: [], buttons: [],
          window: { localStorage: {
            setItem: (...args) => { writes.push(args); if (persists) stored.set(...args); },
            getItem: (key) => stored.get(key) ?? null,
          } } };
        const { load } = fixture(locale, "login", undefined, interaction);
        const consent = load("packages/ui/components/CookieConsent.tsx");
        renderToStaticMarkup(React.createElement(consent.default));
        assert.equal(interaction.buttons.length, 2);
        interaction.buttons[index].onClick();
        assert.deepEqual(writes, [["cookie_consent", choice]]);
        assert.deepEqual(interaction.updates, [{ index: 1, value: !persists }]);
        assert.equal(consent.getCookieConsent(), persists ? choice : null);
      }
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
      // Header names are case-insensitive; the request carries the CSRF companion.
      assert.equal(new Headers(calls[0].options.headers).get("X-Requested-With"), "XMLHttpRequest");
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

// LEGAL_NAV_20260908_BEGIN
const NAV_DOCS = ["privacy", "terms", "cookies", "gdpr", "kvkk", "deletion"];
const NAV_HREFS = ["/privacy", "/terms", "/cookies", "/gdpr", "/kvkk", "/legal/account-deletion"];
const NAV_GDPR_IDS = ["data-controller", "personal-data", "lawful-bases", "cross-border-transfers", "your-rights", "retention", "security", "data-protection-contact"];
// The deletion notice is localized: its nine section titles are runtime catalog keys, in order.
const NAV_DELETION_KEYS = [...read("packages/ui/app/legal/account-deletion/page.tsx").matchAll(/title: runtimeCopy\("(m[0-9a-f]{12})"\)/g)].map((match) => match[1]);
assert.equal(NAV_DELETION_KEYS.length, 9);
// The legal copy moved into the locale catalogs (0f6a05e). Freeze both the
// complete `sections` initializer (structure, ids, keys, JSX) and the exact
// English catalog text it resolves to, so neither can drift without review.
function legalSectionsDigest(route) {
  const path = `packages/ui/app/${route}/page.tsx`;
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "sections") declarations.push(node);
    ts.forEachChild(node, visit);
  })(ast);
  assert.equal(declarations.length, 1);
  const initializer = declarations[0].initializer.getText(ast);
  const english = JSON.parse(read("packages/ui/messages/en.json"));
  const ids = route === "gdpr" ? NAV_GDPR_IDS : [];
  const resolved = route === "gdpr"
    ? ids.map((id) => english.surface.legal.gdpr[id])
    : [...initializer.matchAll(/\b(runtimeCopy|uiText)\("(m[0-9a-f]{12})"\)/g)]
      .map(([, fn, key]) => english[fn === "runtimeCopy" ? "runtime" : "uiCopy"][key]);
  assert.ok(resolved.length > 0 && resolved.every((value) => value !== undefined), `${route}: every section key resolves in English`);
  return createHash("sha256").update(initializer).update("\0").update(JSON.stringify(resolved)).digest("hex");
}
for (const [route, digest] of Object.entries({
  gdpr: "b98e6a5d1aaaf3be569e31fb8d1c8bca40bedc87a7dbeb65c6c0525623607ec3",
  "legal/account-deletion": "ca257727006d86fc18d8fe2b426c99fe932cd64fbf5abc47803705ef0b204042",
})) test(`legal English sections remain byte-identical: ${route}`, () => {
  assert.equal(legalSectionsDigest(route), digest);
});
const LEGAL_PAGE_COPY = {
  en: ["About", "Blog", "Product", "Company", "Command the AI agents & automations you already run.", "All rights reserved.", "This document is currently available in English."],
  tr: ["Hakkımızda", "Blog", "Ürün", "Şirket", "Zaten çalıştırdığınız yapay zekâ ajanlarını ve otomasyonları yönetin.", "Tüm hakları saklıdır.", "Bu belge şu anda İngilizce olarak sunulmaktadır."],
  es: ["Acerca de", "Blog", "Producto", "Empresa", "Dirige los agentes de IA y las automatizaciones que ya utilizas.", "Todos los derechos reservados.", "Este documento está disponible actualmente en inglés."],
  de: ["Über uns", "Blog", "Produkt", "Unternehmen", "Steuere die KI-Agenten und Automatisierungen, die du bereits einsetzt.", "Alle Rechte vorbehalten.", "Dieses Dokument ist derzeit auf Englisch verfügbar."],
  fr: ["À propos", "Blog", "Produit", "Entreprise", "Pilotez les agents IA et les automatisations que vous utilisez déjà.", "Tous droits réservés.", "Ce document est actuellement disponible en anglais."],
  ar: ["نبذة عنا", "المدونة", "المنتج", "الشركة", "تحكّم في وكلاء الذكاء الاصطناعي وعمليات الأتمتة التي تستخدمها بالفعل.", "جميع الحقوق محفوظة.", "هذا المستند متاح حاليًا باللغة الإنجليزية."],
};
const navClass = (node, name) => (node.props.className ?? "").split(/\s+/).includes(name);
const navChildren = (node) => React.Children.toArray(node.props.children);
const navOwnText = (node) => navChildren(node)
  .filter((child) => typeof child === "string" || typeof child === "number").join("").trim();
function navText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(navText).join("");
  return React.isValidElement(value) ? navText(value.props.children) : "";
}
function navElements(owner, predicate) {
  const matches = [];
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!React.isValidElement(value)) return;
    if (predicate(value)) matches.push(value);
    visit(value.props.children);
  }
  visit(owner.props.children);
  return matches;
}
function navOne(nodes, message) {
  assert.equal(nodes.length, 1, message);
  return nodes[0];
}
const navPairs = (owner) => navElements(owner, (n) => n.type === "a")
  .map((n) => [n.props.href, navText(n.props.children).trim()]);
const navLabels = (copy) => [copy.privacy, copy.terms, copy.cookies, "GDPR", "KVKK", copy.accountDeletion];
function navLegalColumn(footer) {
  return navOne(navElements(footer, (n) => n.type === "div"
    && navChildren(n).some((child) => React.isValidElement(child) && child.type === "h5")
    && navElements(n, (child) => child.type === "a" && child.props.href === "/privacy").length === 1),
  "one legal footer column, selected by structure and destination");
}
async function renderLegalNav(locale, route, options = {}) {
  // A fresh fixture per render keeps the actual Terms state index deterministic.
  const interaction = {
    realIntl: true, nodes: [], updates: [], ...options,
    headers: {host: "www.braavolabs.com", "x-braavolabs-surface": "public", "x-braavolabs-pathname": "/" + route},
  };
  const {load, messages} = fixture(locale, "login", undefined, interaction);
  const Page = load("packages/ui/app/" + route + "/page.tsx").default;
  const layout = await load("packages/ui/app/layout.tsx").default({children: React.createElement(Page)});
  const html = renderToStaticMarkup(React.createElement(uiRequire("next-intl").NextIntlClientProvider,
    {locale, timeZone: "UTC", onError: (error) => { throw error; }}, layout));
  const provider = navOne(navElements(layout, (n) => n.props.messages !== undefined), "one actual pruned provider");
  // Captured owners are re-rendered inside the layout's own providers (pruned
  // intl messages + the actual ThemeProvider): the root appearance footer's
  // language/theme selectors need both contexts, exactly as in the full tree.
  const theme = navOne(navElements(layout, (n) => typeof n.type === "function" && n.type.name === "ThemeProvider"),
    "one actual ThemeProvider inside the pruned provider");
  const renderOwned = (node) => renderToStaticMarkup(React.createElement(uiRequire("next-intl").NextIntlClientProvider,
    {locale, timeZone: "UTC", messages: provider.props.messages, onError: (error) => { throw error; }},
    React.cloneElement(theme, undefined, node)));
  for (const tag of ["header", "nav", "article", "footer"]) {
    const actual = html.match(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?</" + tag + ">", "g")) ?? [];
    // Layout-owned chrome is created before the page renders; compare in document order.
    const owned = interaction.nodes.filter((n) => n.type === tag).map(renderOwned);
    const position = (markup) => html.indexOf(markup);
    assert.deepEqual(actual, [...owned].sort((a, b) => position(a) - position(b)),
      `${locale}/${route}: ${tag} owners really rendered`);
  }
  assert.doesNotMatch(html, /static\.common\.legalNavigation\.|\{title\}/);
  // The root layout owns exactly one appearance bar (language + theme). Page
  // chrome contracts below see only page-owned nodes.
  const appearance = navOne(interaction.nodes.filter((n) => n.type === "footer" && navClass(n, "bv-appearance-bar")),
    "one root-owned appearance bar");
  assert.equal(navElements(appearance, (n) => typeof n.type === "function").map((n) => n.type.name).join(","),
    "LanguageSwitcher,ThemeSelector");
  assert.match(html, /<footer class="bv-appearance-bar">[\s\S]*?<select[^>]*aria-label="[^"]+"[\s\S]*?<select aria-label="[^"]+"[\s\S]*?<\/footer>/);
  return {interaction, messages, nodes: interaction.nodes.filter((n) => n !== appearance), providerMessages: provider.props.messages};
}

for (const locale of LOCALES) {
  test(`legal page copy ${locale}: neutral presentation labels only`, () => {
    const copy = JSON.parse(read(`packages/ui/messages/${locale}.json`)).static.common.legalPage;
    const keys = ["about", "blog", "product", "company", "tagline", "rights", "englishOnly"];
    assert.deepEqual(Object.keys(copy ?? {}).sort(), [...keys].sort());
    assert.deepEqual(keys.map((key) => copy[key]), LEGAL_PAGE_COPY[locale]);
  });
  for (const route of ["terms", "gdpr", "legal/account-deletion"]) {
    test(`legal-nav ${locale}/${route}: exact owned chrome, public pruning and ICU`, async () => {
      const {nodes, messages} = await renderLegalNav(locale, route);
      const copy = LEGAL_CHROME[locale];
      const header = navOne(nodes.filter((n) => n.type === "header"), "one page header");
      const eyebrow = navOne(navElements(header, (n) => navClass(n, "bv-pill")
        && navElements(n, (child) => child.type === "span"
          && navClass(child, "material-symbols-outlined") && navOwnText(child) === "gavel").length === 1), "one legal eyebrow owner");
      assert.equal(navOwnText(eyebrow), copy.legal);
      const openApp = navOne(nodes.filter((n) => n.type === "a" && n.props.href === "https://app.braavolabs.com"), "one existing app destination");
      assert.equal(navText(openApp.props.children).trim(), copy.openApp);
      assert.ok(navClass(openApp, "bv-legal-cta") && navClass(openApp, "bv-btn-primary"), "actual app CTA owns stationary RTL decoration and reduced-motion scope");
      const pills = navElements(header, (n) => navClass(n, "bv-fpill"));
      assert.equal(pills.length, 6);
      assert.deepEqual(pills.map((n) => navText(n.props.children).trim()), navLabels(copy));
      assert.deepEqual(pills.map((n) => n.type), Array(6).fill(route === "terms" ? "button" : "a"));
      assert.deepEqual(pills.filter((n) => navClass(n, "active")).map((n) => navText(n.props.children).trim()),
        [route === "terms" ? copy.terms : route === "gdpr" ? "GDPR" : copy.accountDeletion]);
      if (route === "terms") assert.equal(navElements(header, (n) => n.type === "a").length, 0);
      else assert.deepEqual(pills.map((n) => n.props.href), NAV_HREFS);

      const title = navOne(navElements(header, (n) => n.type === "h1"), "one unchanged document title");
      assert.equal(navText(title.props.children).trim(), route === "terms"
        ? messages.static.legal.terms.title : route === "gdpr" ? messages.surface.legal.gdprTitle : messages.uiCopy.m3b525be54f32);
      const date = navOne(navElements(header, (n) => n.type === "p" && navClass(n, "bv-mono")), "one unchanged date");
      assert.equal(navText(date.props.children).trim(), route === "terms"
        ? messages.static.common.lastUpdated + " " + messages.static.legal.terms.date
        : messages.static.common.lastUpdated + " " + new Intl.DateTimeFormat(locale, {month: "long", year: "numeric", timeZone: "UTC"})
          .format(new Date(route === "gdpr" ? "2026-10-20T00:00:00Z" : "2026-05-01T00:00:00Z")));
      if (route === "gdpr") {
        // The localized GDPR preview shows its translated preview notice to every visitor.
        const banners = navElements(header, (n) => navClass(n, "bv-panel"));
        assert.equal(banners.length, 1);
        {
          assert.equal(navOwnText(banners[0]), messages.surface.legal.previewNotice);
          const style = banners[0].props.style;
          assert.equal(style.display, "flex", "notice owns a block row separate from the legal badge");
          assert.equal(style.width, "fit-content");
          assert.equal(style.maxWidth, "100%");
          assert.equal(style.margin, "0 auto 20px", "short translations are independently centered");
          assert.notEqual(banners[0], eyebrow);
        }
      }

      const toc = navOne(nodes.filter((n) => n.type === "nav" && n.props["aria-label"] !== undefined), "one actual labelled TOC");
      assert.equal(toc.props["aria-label"], copy.onThisPage);
      const tocLabel = navOne(navElements(toc, (n) => n.type === "p" && navClass(n, "bv-micro")), "one visible TOC label");
      assert.equal(navOwnText(tocLabel), copy.onThisPage);
      const titles = route === "terms" ? messages.static.legal.terms.sections.map((s) => s.title)
        : route === "gdpr" ? NAV_GDPR_IDS.map((id) => messages.surface.legal.gdpr[id].title) : NAV_DELETION_KEYS.map((key) => messages.runtime[key]);
      const tocLinks = navElements(toc, (n) => n.type === "a");
      assert.deepEqual(tocLinks.map((n) => navText(n.props.children).trim()), titles);
      const article = navOne(nodes.filter((n) => n.type === "article"), "one prose article");
      const headings = navElements(article, (n) => n.type === "h2");
      assert.equal(headings.length, titles.length);
      headings.forEach((heading, index) => {
        const permalink = navOne(navElements(heading, (n) => n.type === "a"), "one owned section permalink");
        assert.equal(permalink.props["aria-label"], copy.permalinkTo.replace("{title}", titles[index]));
        assert.equal(permalink.props.href, tocLinks[index].props.href);
        assert.equal(navText(permalink.props.children).trim(), "¶");
        const headingText = route === "legal/account-deletion"
          ? navOwnText(navOne(navElements(heading, (n) => n.type === "span" && !navClass(n, "material-symbols-outlined")), "one deletion heading label"))
          : navOwnText(heading);
        assert.equal(headingText, titles[index]);
      });
      const footers = nodes.filter((n) => n.type === "footer");
      assert.equal(footers.length, route === "gdpr" ? 0 : 1);
      if (route !== "gdpr") {
        const column = navLegalColumn(footers[0]);
        const label = navOne(navElements(column, (n) => n.type === "h5"), "one legal footer heading");
        assert.equal(navOwnText(label), copy.legal);
        assert.deepEqual(navPairs(column), route === "terms"
          ? NAV_HREFS.map((href, i) => [href, navLabels(copy)[i]])
          : [["/privacy", copy.privacy], ["/terms", copy.terms], ["/kvkk", "KVKK"], ["/gdpr", "GDPR"]]);
      }
    });

    test(`legal offset ${locale}/${route}: page-owned TOC and exact fragment targets share the responsive gap`, async () => {
      const {nodes} = await renderLegalNav(locale, route);
      const shell = navOne(nodes.filter((n) => n.type === "div" && navClass(n, "bv-mesh")), "one page-owned offset scope");
      assert.ok(navClass(shell, "[--bv-legal-offset:140px]"), "wrapped navigation gap below 1024px");
      assert.ok(navClass(shell, "lg:[--bv-legal-offset:90px]"), "single-row gap at 1024px and above");
      const toc = navOne(navElements(shell, (n) => n.type === "nav" && n.props["aria-label"]), "page-owned sticky TOC");
      assert.equal(toc.props.style.top, "var(--bv-legal-offset)");
      for (const link of navElements(toc, (n) => n.type === "a")) {
        assert.match(link.props.href, /^#[a-z0-9]+(?:-[a-z0-9]+)*$/);
        const target = navOne(navElements(shell, (n) => n.props.id === link.props.href.slice(1)), "one actual fragment target, not an unaddressed descendant");
        assert.equal(target.type, route === "legal/account-deletion" ? "section" : "h2");
        assert.equal(target.props.style.scrollMarginTop, "var(--bv-legal-offset)");
      }
    });

    test(`legal chrome follow-up ${locale}/${route}: localized shell and canonical English boundaries`, async () => {
      const {nodes, messages, providerMessages} = await renderLegalNav(locale, route);
      const common = messages.static.common, copy = common.legalPage;
      const top = navOne(nodes.filter((n) => n.type === "nav" && !n.props["aria-label"]), "one top navigation");
      const header = navOne(nodes.filter((n) => n.type === "header"), "one header");
      // Public pruning: the shared client chrome namespaces plus per-route static
      // copy only; authenticated namespaces (auth, app, billing, ...) never ship.
      const shared = ["language", "runtime", "static", "surface", "uiCopy"];
      assert.deepEqual(Object.keys(providerMessages).sort(), route === "gdpr" ? shared : ["nav", ...shared].sort());
      // BRV-09: the client receives only what the route's client modules can read
      // (scripts/public-message-manifest.mjs); language/runtime stay whole.
      const entry = PUBLIC_MESSAGE_MANIFEST["/" + route];
      assert.ok(entry, `manifest entry for /${route}`);
      for (const key of ["language", "runtime"]) assert.equal(providerMessages[key], messages[key]);
      assert.deepEqual(Object.keys(providerMessages.uiCopy).sort(), [...entry.uiCopy].sort());
      for (const id of entry.uiCopy) assert.equal(providerMessages.uiCopy[id], messages.uiCopy[id]);
      assert.ok(Object.keys(providerMessages.uiCopy).length * 10 < Object.keys(messages.uiCopy).length, "uiCopy narrowed");
      if (entry.surface.includes("surface")) assert.equal(providerMessages.surface, messages.surface);
      else for (const path of entry.surface) {
        const key = path.split(".").slice(1);
        const value = (root) => key.reduce((node, part) => node?.[part], root);
        assert.equal(value(providerMessages.surface), value(messages.surface), path);
      }
      const chrome = ["appearance", "common", "cookieConsent"];
      if (route === "gdpr") {
        assert.deepEqual(Object.keys(providerMessages.static).sort(), [...chrome, "singleLocale"].sort());
        const back = navOne(navElements(top, (n) => n.type === "a" && n.props.href === "/" && navClass(n, "bv-btn-ghost")), "one translated back link, with no extra icon");
        assert.equal(back.props.href, "/");
        const direction = locale === "ar" ? "→" : "←";
        assert.equal(navText(back).trim(), locale === "ar" ? "→ رجوع" : common.back);
        assert.equal((navText(back).match(/[←→]/g) ?? []).length, 1);
        assert.ok(navText(back).includes(direction));
        assert.equal(navElements(back, (n) => navText(n) === "arrow_back").length, 0);
      } else {
        assert.deepEqual(Object.keys(providerMessages.nav).sort(), ["features", "pricing", "signIn"]);
        assert.deepEqual(Object.keys(providerMessages.static).sort(), [...chrome, "changelog", "contact", ...(route === "terms" ? ["legal"] : [])].sort());
        for (const key of ["changelog", "contact"]) assert.deepEqual(Object.keys(providerMessages.static[key]), ["title"]);
        const links = [["/features", messages.nav.features], ["/pricing", messages.nav.pricing], ["/about", copy.about]];
        if (route === "terms") links.push(["/changelog", messages.static.changelog.title]);
        for (const [href, label] of [...links, ["https://app.braavolabs.com/login", messages.nav.signIn]]) {
          assert.deepEqual(navPairs(top).filter(([destination]) => destination === href), [[href, label]]);
        }
        const footer = navOne(nodes.filter((n) => n.type === "footer"), "one footer");
        for (const [heading, pairs] of [
          [copy.product, [["/features", messages.nav.features], ["/pricing", messages.nav.pricing], ["/changelog", messages.static.changelog.title]]],
          [copy.company, [["/about", copy.about], ["/blog", copy.blog], ["/contact", messages.static.contact.title]]],
        ]) {
          const column = navOne(navElements(footer, (n) => n.type === "div" && navChildren(n).some((c) => React.isValidElement(c) && c.type === "h5" && navText(c) === heading)), "one translated footer column");
          assert.deepEqual(navPairs(column), pairs);
        }
        const paragraphs = navElements(footer, (n) => n.type === "p").map((n) => navText(n).trim());
        assert.ok(paragraphs.includes(copy.tagline));
        assert.ok(paragraphs.includes(`© ${new Date().getFullYear()} Braavolabs. ${copy.rights}`));
        assert.ok(!paragraphs.includes(messages.footer.rights), "do not substitute the different Claude attribution");
      }
      const title = navOne(navElements(header, (n) => n.type === "h1"), "one document title");
      const article = navOne(nodes.filter((n) => n.type === "article"), "one canonical article");
      const toc = navOne(nodes.filter((n) => n.type === "nav" && n.props["aria-label"]), "one localized TOC");
      if (route === "terms") {
        const shell = navOne(nodes.filter((n) => n.type === "div" && navClass(n, "bv-mesh")), "page-owned shell, excluding RootLayout's separate skip link");
        const skip = navOne(navChildren(shell).filter((n) => React.isValidElement(n) && n.type === "a" && navClass(n, "skip-link")), "one page-owned skip link");
        assert.equal(navText(skip), common.skipToMainContent);
      } else {
        // GDPR and account deletion are localized documents: language and direction follow the locale.
        const docLang = locale, docDir = docLang === "ar" ? "rtl" : "ltr";
        const links = navOne(navElements(toc, (n) => n.type === "div" && n.props.lang === docLang), "document-language TOC link group, not its local label");
        for (const owner of [title, article, links]) {
          assert.equal(owner.props.lang, docLang);
          assert.equal(owner.props.dir, docDir);
        }
        assert.equal(toc.props.lang, undefined);
        assert.equal(navElements(links, (n) => n.type === "p").length, 0);
        for (const link of navElements(article, (n) => n.type === "a" && n.props["aria-label"])) {
          assert.equal(link.props.lang, locale);
          assert.equal(link.props.dir, locale === "ar" ? "rtl" : "ltr");
        }
        const time = navOne(navElements(header, (n) => n.type === "time"), "one fixed document month");
        assert.equal(time.props.dateTime, route === "gdpr" ? "2026-10-20" : "2026-05");
      }
      if (route === "legal/account-deletion") {
        // A localized notice must not claim to be available only in English.
        assert.equal(navElements(header, (n) => navClass(n, "bv-panel")).length, 0);
      }
    });
  }

  test(`legal-nav ${locale}/terms: deletion branch uses one truthful canonical URL`, async () => {
    const {nodes} = await renderLegalNav(locale, "terms", {initial: {0: "deletion"}});
    const header = navOne(nodes.filter((n) => n.type === "header"), "actual alternate header");
    const title = navOne(navElements(header, (n) => n.type === "h1"), "alternate document title");
    const pills = navElements(header, (n) => navClass(n, "bv-fpill"));
    const article = navOne(nodes.filter((n) => n.type === "article"), "actual alternate article");
    assert.equal(navElements(article, (n) => n.type === "h2").length, 0);
    const link = navOne(navElements(article, (n) => n.type === "a"), "one placeholder URL");
    assert.equal(link.props.href, "/legal/account-deletion");
    assert.equal(navText(link.props.children).trim(), "braavolabs.com/legal/account-deletion");
    assert.equal(navText(title.props.children).trim(), LEGAL_CHROME[locale].accountDeletion);
    assert.deepEqual(pills.filter((n) => navClass(n, "active")).map((n) => navText(n.props.children).trim()), [LEGAL_CHROME[locale].accountDeletion]);
    const footer = navOne(nodes.filter((n) => n.type === "footer"), "actual footer");
    assert.deepEqual(navPairs(navLegalColumn(footer)), NAV_HREFS.map((href, i) => [href, navLabels(LEGAL_CHROME[locale])[i]]));
    assert.equal(nodes.filter((n) => n.type === "a" && n.props.href === "/deletion").length, 0);
    assert.equal(navElements(header, (n) => n.type === "time").length, 0,
      "alternate document must not display the Terms date or a stale English date");
    assert.equal(navText(header).includes("June 1, 2026"), false);
  });

  test(`legal-nav ${locale}/terms: six real buttons preserve state and scroll handlers`, async () => {
    const scrolls = [];
    const {nodes, interaction} = await renderLegalNav(locale, "terms", {
      window: {scrollTo(options) { scrolls.push({keys: Object.keys(options), top: options.top}); }},
    });
    const header = navOne(nodes.filter((n) => n.type === "header"), "one actual header");
    const buttons = navElements(header, (n) => n.type === "button" && navClass(n, "bv-fpill"));
    assert.equal(buttons.length, 6);
    assert.equal(navElements(header, (n) => n.type === "a").length, 0);
    assert.deepEqual(buttons.map((n) => navClass(n, "active")), [false, true, false, false, false, false]);
    buttons.forEach((button, index) => {
      interaction.updates.length = 0;
      scrolls.length = 0;
      assert.equal(typeof button.props.onClick, "function");
      button.props.onClick();
      assert.deepEqual(interaction.updates, [{index: 0, value: NAV_DOCS[index]}]);
      assert.deepEqual(scrolls, [{keys: ["top"], top: 0}]);
    });
  });
}
// LEGAL_NAV_20260908_END
