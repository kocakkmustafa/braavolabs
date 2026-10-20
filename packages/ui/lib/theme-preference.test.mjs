import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(UI, "package.json"));
const ts = req("typescript"), jsx = req("react/jsx-runtime");
const { createTranslator } = req("next-intl");
function load(file, globals = {}, boundaries = {}) {
  const result = ts.transpileModule(readFileSync(resolve(UI, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(result.diagnostics.length, 0, `${file} syntax`);
  const exports = {};
  vm.runInNewContext(result.outputText, { exports, ...globals, require: name => {
    if (name === "react/jsx-runtime") return jsx;
    if (name in boundaries) return boundaries[name];
    throw Error(`Uncontrolled boundary ${name}`);
  } });
  return exports;
}
const theme = load("lib/theme-preference.ts");

function fixture(stored, prefersDark = false) {
  const values = new Map(Object.entries(stored ?? {})), classes = new Set(["dark"]);
  const storageListeners = new Set(), mediaListeners = new Set();
  const flags = { blockedRead: false, blockedWrite: false, ignoredWrite: false, prefersDark };
  const root = { classList: { toggle(value, active) { active ? classes.add(value) : classes.delete(value); } }, style: {}, dataset: {} };
  const localStorage = {
    getItem(key) { if (flags.blockedRead) throw Error("storage denied"); return values.get(key) ?? null; },
    setItem(key, value) { if (flags.blockedWrite) throw Error("storage denied"); if (!flags.ignoredWrite) values.set(key, value); },
  };
  const media = { get matches() { return flags.prefersDark; },
    addEventListener(type, listener) { assert.equal(type, "change"); mediaListeners.add(listener); },
    removeEventListener(type, listener) { mediaListeners.delete(listener); },
  };
  const window = { localStorage, matchMedia: () => media,
    addEventListener(type, listener) { assert.equal(type, "storage"); storageListeners.add(listener); },
    removeEventListener(type, listener) { storageListeners.delete(listener); },
  };
  return { values, classes, root, window, flags, mediaListeners, storageListeners,
    system(value) { flags.prefersDark = value; for (const fn of mediaListeners) fn(); },
    storage(key, newValue = "stale-event-value") { for (const fn of storageListeners) fn({ key, newValue }); },
  };
}
function assertTheme(f, preference, resolved) {
  assert.equal(f.root.dataset.theme, preference);
  assert.equal(f.root.dataset.resolvedTheme, resolved);
  assert.equal(f.root.style.colorScheme, resolved);
  assert.equal(f.classes.has("light"), resolved === "light");
  assert.equal(f.classes.has("dark"), resolved === "dark");
}

test("exact before-paint script respects stored light/dark/system and the OS", () => {
  for (const preference of [undefined, "light", "dark", "system"]) for (const osDark of [false, true]) {
    const f = fixture(preference ? { "braavo-theme": preference } : {}, osDark);
    vm.runInNewContext(theme.THEME_INIT_SCRIPT, { window: f.window, document: { documentElement: f.root } });
    assertTheme(f, preference ?? "system", preference && preference !== "system" ? preference : osDark ? "dark" : "light");
  }
});

test("legacy theme migration preserves auth storage and the dedicated preference wins", () => {
  const legacy = JSON.stringify({ state: { theme: "light", token: "synthetic-auth-fixture" } });
  const f = fixture({ "aicos-auth": legacy }, true);
  theme.initializeTheme(f.window, f.root); assertTheme(f, "light", "light");
  assert.equal(f.values.get("aicos-auth"), legacy);
  assert.equal(f.values.has("braavo-theme"), false, "reading a legacy preference has no write side effect");
  f.values.set("braavo-theme", "dark"); theme.initializeTheme(f.window, f.root); assertTheme(f, "dark", "dark");
});

test("invalid/corrupt/unavailable storage fails safely; a missing media API has a dark fallback", () => {
  for (const stored of [{ "braavo-theme": "invalid" }, { "aicos-auth": "not json" }, {}]) {
    const f = fixture(stored); theme.initializeTheme(f.window, f.root); assertTheme(f, "system", "light");
  }
  const blocked = fixture(); blocked.flags.blockedRead = true;
  theme.initializeTheme(blocked.window, blocked.root); assertTheme(blocked, "system", "light");
  blocked.window.matchMedia = undefined;
  theme.initializeTheme(blocked.window, blocked.root); assertTheme(blocked, "system", "dark");
});

test("saving requires readback, never mutates the legacy auth record, and reports failure", () => {
  const f = fixture({ "aicos-auth": "synthetic unchanged record" });
  assert.equal(theme.persistThemePreference(f.window.localStorage, "light"), true);
  assert.equal(f.values.get("aicos-auth"), "synthetic unchanged record");
  f.flags.blockedWrite = true;
  assert.equal(theme.persistThemePreference(f.window.localStorage, "dark"), false);
  f.flags.blockedWrite = false; f.flags.ignoredWrite = true;
  assert.equal(theme.persistThemePreference(f.window.localStorage, "dark"), false);
});

function hooks() {
  const states = [], refs = [], callbacks = [], effects = [];
  let stateIndex = 0, refIndex = 0, callbackIndex = 0, effectIndex = 0;
  return {
    react: {
      createContext: () => ({ Provider: "fixture-provider" }), useContext: () => null,
      useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
      useRef(initial) { const i = refIndex++; return refs[i] ??= { current: initial }; },
      useCallback(fn) { return callbacks[callbackIndex++] ??= fn; },
      useEffect(fn) { effects[effectIndex++] ??= { fn }; },
    },
    render(component) { stateIndex = refIndex = callbackIndex = effectIndex = 0; return component({ children: "fixture-content" }); },
    mount() { for (const entry of effects) entry.cleanup = entry.fn(); },
    unmount() { for (const entry of effects) entry.cleanup?.(); },
  };
}
function provider(f) {
  const h = hooks();
  const component = load("components/ThemeProvider.tsx", { window: f.window, document: { documentElement: f.root } }, {
    react: h.react, "../lib/theme-preference": theme,
  }).default;
  h.render(component); h.mount();
  return { h, value: () => h.render(component).props.value };
}

test("actual provider follows OS changes only in system mode and latest rapid choice wins", () => {
  const f = fixture(), p = provider(f);
  assertTheme(f, "system", "light"); f.system(true); assertTheme(f, "system", "dark");
  p.value().setPreference("light"); f.system(true); assertTheme(f, "light", "light");
  p.value().setPreference("dark"); p.value().setPreference("light"); p.value().setPreference("system");
  assertTheme(f, "system", "dark"); assert.equal(f.values.get("braavo-theme"), "system");
  assert.equal(p.value().saveFailed, false);
  p.h.unmount(); assert.equal(f.storageListeners.size, 0); assert.equal(f.mediaListeners.size, 0);
});

test("actual provider reads the latest storage value, not a late event's stale value", () => {
  const f = fixture({ "braavo-theme": "dark" }), p = provider(f);
  f.values.set("braavo-theme", "light"); f.storage("braavo-theme", "dark");
  assertTheme(f, "light", "light"); assert.equal(p.value().preference, "light");
});

test("storage failure keeps the explicit choice in this document and exposes a failure state", () => {
  const f = fixture({ "aicos-auth": JSON.stringify({ state: { theme: "dark" } }) }), p = provider(f);
  f.flags.blockedWrite = true; p.value().setPreference("light");
  assertTheme(f, "light", "light"); assert.equal(p.value().saveFailed, true);
  f.storage("aicos-auth"); assertTheme(f, "light", "light");
});

test("actual native selector rejects unsupported values and renders the translated persistence warning", () => {
  const messages = JSON.parse(readFileSync(resolve(UI, "messages/en.json"), "utf8"));
  const t = createTranslator({ locale: "en", messages, namespace: "static.appearance" });
  const choices = [], component = load("components/ThemeSelector.tsx", {}, {
    "next-intl": { useTranslations: () => t },
    "./ThemeProvider": { useThemePreference: () => ({ preference: "light", saveFailed: true, setPreference: value => choices.push(value) }) },
  }).default;
  const tree = component();
  const label = tree.props.children[0], select = label.props.children[1];
  assert.equal(label.type, "label"); assert.equal(select.type, "select");
  assert.deepEqual(Array.from(select.props.children, option => option.props.value), ["system", "light", "dark"]);
  select.props.onChange({ target: { value: "invalid" } }); select.props.onChange({ target: { value: "dark" } });
  assert.deepEqual(choices, ["dark"]);
  assert.equal(tree.props.children[1].props.role, "status");
  assert.equal(tree.props.children[1].props.children, t("saveFailed"));
});
