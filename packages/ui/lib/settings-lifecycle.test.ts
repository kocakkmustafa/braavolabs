/** Actual Settings TSX callbacks with deterministic hook/API boundaries.
 * This is module/handler evidence; it does not claim browser rendering. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let n = 0; n < 8; n++) await Promise.resolve(); }

function settingsHarness() {
  const h: any = {
    session: { token: "synthetic-A", tenantId: "tenant-A", revision: 1 },
    calls: [], writes: [], feedback: [], pending: {}, tree: null,
  };
  const instances = new Map<string, any>();
  let context: any;
  let childId: string | undefined;
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial: any) {
      const instance = context, index = instance.stateIndex++;
      if (!(index in instance.states)) instance.states[index] = typeof initial === "function" ? initial() : initial;
      return [instance.states[index], (value: any) => {
        h.writes.push([instance.id, index]);
        instance.states[index] = typeof value === "function" ? value(instance.states[index]) : value;
      }];
    },
    useId: () => "fixture-field-id",
    useRef(initial: any) { const index = context.refIndex++; return context.refs[index] ??= { current: initial }; },
    useEffect(fn: any, deps: any[]) {
      const index = context.effectIndex++, previous = context.effects[index];
      if (!previous || !same(previous.deps, deps)) context.effects[index] = { deps, fn, cleanup: previous?.cleanup, pending: true };
    },
  };
  const storeState = () => ({ ...h.session, sessionRevision: h.session.revision });
  const store = Object.assign((selector: any) => selector(storeState()), { getState: storeState });
  const current = (owner: any) => owner.revision === h.session.revision && owner.tenantId === h.session.tenantId;
  function call(name: string, args: any[]) {
    h.calls.push([name, ...args]);
    if (h.pending[name]) return h.pending[name];
    const values: Record<string, any> = {
      billingUsage: { plan: "INDIVIDUAL", live: { runs: 0, toolCalls: 0 } }, billingSubscription: {},
      getReferral: { code: "synthetic-referral", stats: {} },
      listProviders: [{ provider: "fixture", name: "Fixture", fields: [], setupGuide: "fixture" }],
      "users.me": { name: "Profile-A", email: "private-A@example.invalid", createdAt: "2026-01-01", tenant: { name: "Workspace-A" } },
      getNotificationPrefs: {}, listCompanies: [{ id: "company-A", name: "Company-A" }, { id: "company-B", name: "Company-B" }],
      listIntegrations: [{ provider: "fixture", status: "ACTIVE", fieldsSet: [] }],
      "ai-get": { provider: "ANTHROPIC", model: "stored-A", hasApiKey: true, maskedApiKey: "masked-A", baseUrl: "" },
      "ai-save": { success: true }, "ai-test": { success: true, response: "synthetic OK" },
      models: { models: ["synthetic-model"] }, "users.updateMe": { name: "Updated" },
    };
    return Promise.resolve(values[name] ?? {});
  }
  const api: any = new Proxy({ users: new Proxy({}, { get: (_, key) => (...args: any[]) => call(`users.${String(key)}`, args) }) },
    { get: (object: any, key) => key in object ? object[key] : (...args: any[]) => call(String(key), args) });
  const endpoint = (path: string, options: any) => path.endsWith("/test") ? "ai-test"
    : path.includes("/models") ? "models" : options?.method === "PUT" ? "ai-save" : "ai-get";
  const apiFetch = (path: string, options: any) => {
    h.calls.push(["apiFetch", path, options]); return call(endpoint(path, options), [path, options]);
  };
  const rawFetch = async (path: string, options: any) => {
    h.calls.push(["rawFetch", path, options]);
    return { ok: true, json: () => call(endpoint(path, options), [path, options]) };
  };
  const element = (type: any, props: any, key?: any) => ({ type, props: props ?? {}, key });
  const source = process.env.SETTINGS_TEST_BASELINE === "HEAD"
    ? execFileSync("git", ["show", "HEAD:packages/ui/app/settings/page.tsx"], { cwd: resolve(process.cwd(), "../.."), encoding: "utf8" })
    : readFileSync(resolve(process.cwd(), "app/settings/page.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as any };
  const requireLocal = (name: string): any => {
    if (name === "react") return hooks;
    if (name.endsWith("/localized-error") || name.endsWith("/i18n/locales")) {
      const relative = name.endsWith("/localized-error") ? "lib/localized-error.ts" : "i18n/locales.ts";
      const localModule = { exports: {} as any };
      const compiled = ts.transpileModule(readFileSync(resolve(process.cwd(), relative), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      runInNewContext("(function(require,module,exports){" + compiled + "\n})", { Intl, Date, Error })(requireLocal, localModule, localModule.exports);
      return localModule.exports;
    }
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "next/navigation") return { useRouter: () => ({ replace: (path: string) => h.feedback.push(["replace", path]) }) };
    if (name === "next-intl") return { useLocale: () => "en", useTranslations: () => (key: string) => key };
    if (name.endsWith("/api")) return { api, apiFetch };
    if (name.endsWith("/store")) return { useAppStore: store, captureAuthSession: () => ({ ...h.session }), isAuthSessionCurrent: current };
    if (name.endsWith("/useAuthGuard")) return { useAuthGuard: () => ({ token: h.session.token, hydrated: true }) };
    if (name.endsWith("/Toast")) return { useToast: () => ({ toast: (...args: any[]) => h.feedback.push(args) }) };
    if (name.endsWith("/plan-entitlements")) return { planAllowsLocalProvider: () => true };
    if (name === "@ai-company-os/core") return { PLAN_LIMITS: { FREE: { maxRunsPerMonth: 1, maxCompanies: 1 }, INDIVIDUAL: { maxRunsPerMonth: 10, maxCompanies: 3 } }, PLAN_PRICING: {}, PLAN_LABEL: {}, PLAN_ORDER: [] };
    throw new Error(`Unexpected Settings import: ${name}`);
  };
  runInNewContext("(function(require,module,exports){" + code + "\n})", {
    console, AbortController, setTimeout, clearTimeout, fetch: rawFetch,
    window: { location: { set href(value: string) { h.feedback.push(["href", value]); } } },
  })(requireLocal, module, module.exports);
  function renderComponent(component: any, id: string) {
    context = instances.get(id);
    if (!context) { context = { id, states: [], refs: [], effects: [] }; instances.set(id, context); }
    context.stateIndex = context.refIndex = context.effectIndex = 0;
    return component();
  }
  const retire = (id: string) => { const instance = instances.get(id); instance?.effects.forEach((effect: any) => effect?.cleanup?.()); instances.delete(id); };
  function expand(node: any): any {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  h.render = () => {
    let tree = renderComponent(module.exports.default, "root");
    if (typeof tree?.type === "function") {
      const id = "content:" + tree.key;
      if (childId && childId !== id) retire(childId);
      childId = id; tree = renderComponent(tree.type, id);
    } else if (!tree && childId) { retire(childId); childId = undefined; }
    h.tree = expand(tree); return h.tree;
  };
  h.flushEffects = () => { for (const instance of instances.values()) for (const effect of instance.effects) if (effect?.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } };
  h.mount = async () => { h.render(); h.flushEffects(); await settle(); h.render(); h.flushEffects(); await settle(); h.render(); h.writes = []; };
  function walk(node: any, predicate: any): any {
    if (Array.isArray(node)) { for (const child of node) { const found = walk(child, predicate); if (found) return found; } return; }
    if (!node || typeof node !== "object") return;
    return predicate(node) ? node : walk(node.props?.children, predicate);
  }
  h.find = (predicate: any) => { const node = walk(h.tree, predicate); if (!node) throw new Error("Settings control missing"); return node; };
  h.button = (text: string) => h.find((node: any) => node.type === "button" && JSON.stringify(node.props.children).includes(text));
  h.nav = async (key: string) => { h.button(`app.settings.${key}`).props.onClick(); h.render(); h.flushEffects(); await settle(); h.render(); };
  h.password = () => h.find((node: any) => node.type === "input" && node.props.type === "password");
  h.typeKey = (value: string) => { h.password().props.onChange({ target: { value } }); h.render(); };
  h.company = (value: string) => { h.find((node: any) => node.type === "select" && JSON.stringify(node.props.children).includes("Company-A")).props.onChange({ target: { value } }); h.render(); h.flushEffects(); };
  h.unmount = () => { for (const id of [...instances.keys()]) retire(id); };
  h.text = () => JSON.stringify(h.tree);
  return h;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("resets the first B frame including profile, selected company and an unsaved AI key", async () => {
  const h = settingsHarness(); await h.mount(); await h.nav("navAi"); h.typeKey("synthetic-private-A");
  expect(h.password().props.value).toBe("synthetic-private-A");
  Object.assign(h.session, { token: "synthetic-B", tenantId: "tenant-B", revision: 2 });
  h.render(); // Deliberately inspect before B's effects or API responses.
  expect(h.text()).not.toContain("synthetic-private-A");
  expect(h.text()).not.toContain("private-A@example.invalid");
  expect(h.text()).not.toContain("Company-A");
  h.unmount();
});
it.each(["resolve", "reject"])("a late AI save %s cannot write state, feedback or timers after owner retirement", async outcome => {
  const h = settingsHarness(); await h.mount(); await h.nav("navAi"); h.typeKey("synthetic-key");
  const pending = deferred(); h.pending["ai-save"] = pending.promise;
  const action = h.button("app.settings.aiSaveButton").props.onClick();
  h.session.revision++; h.writes = []; h.feedback = [];
  if (outcome === "resolve") pending.resolve({ success: true }); else pending.reject(new Error("synthetic late error"));
  await action;
  expect(h.writes).toEqual([]); expect(h.feedback).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  h.unmount();
});
it("an older company's integration read cannot replace the newly selected resource", async () => {
  const h = settingsHarness(), old = deferred(); h.pending.listIntegrations = old.promise;
  await h.mount(); await h.nav("navIntegrations");
  h.pending.listIntegrations = Promise.resolve([{ provider: "fixture", status: "NEW_COMPANY", fieldsSet: [] }]);
  h.company("company-B"); await settle(); h.render(); h.writes = [];
  old.resolve([{ provider: "fixture", status: "OLD_COMPANY", fieldsSet: [] }]); await settle(); h.render();
  expect(h.writes).toEqual([]); expect(h.text()).toContain("NEW_COMPANY"); expect(h.text()).not.toContain("OLD_COMPANY");
  h.unmount();
});
it("uses the bounded API boundary for every AI endpoint and aborts it on unmount", async () => {
  const h = settingsHarness(); await h.mount(); await h.nav("navAi"); h.typeKey("synthetic-key");
  await h.button("app.settings.aiSaveButton").props.onClick(); h.render();
  await h.button("app.settings.testConnection").props.onClick();
  expect(h.calls.filter((call: any[]) => call[0] === "rawFetch")).toHaveLength(0);
  const requests = h.calls.filter((call: any[]) => call[0] === "apiFetch");
  expect(requests.map((call: any[]) => call[1])).toEqual(expect.arrayContaining(["/settings/ai-config", "/settings/ai-providers/ANTHROPIC/models", "/settings/ai-config/test"]));
  h.unmount(); expect(requests.every((call: any[]) => call[2].signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves unsaved edits and does not reload config on a same-owner token refresh", async () => {
  const h = settingsHarness(); await h.mount(); await h.nav("navAi"); h.typeKey("synthetic-draft");
  const reads = h.calls.filter((call: any[]) => call[0] === "ai-get").length;
  h.session.token = "synthetic-refreshed"; h.render(); h.flushEffects(); await settle(); h.render();
  expect(h.password().props.value).toBe("synthetic-draft");
  expect(h.calls.filter((call: any[]) => call[0] === "ai-get")).toHaveLength(reads);
  h.unmount();
});
it("a save of an older draft cannot erase a newly typed AI key or claim it was saved", async () => {
  const h = settingsHarness(); await h.mount(); await h.nav("navAi"); h.typeKey("synthetic-first");
  const pending = deferred(); h.pending["ai-save"] = pending.promise;
  const action = h.button("app.settings.aiSaveButton").props.onClick();
  h.typeKey("synthetic-second"); pending.resolve({ success: true }); await action; h.render();
  expect(h.password().props.value).toBe("synthetic-second");
  expect(h.text()).not.toContain("app.settings.aiSavedToast");
  h.unmount();
});
it("a late initial AI config cannot replace the provider selected while it was loading", async () => {
  const h = settingsHarness(), pending = deferred(); h.pending["ai-get"] = pending.promise;
  await h.mount(); await h.nav("navAi");
  h.button("OpenAI").props.onClick(); h.render(); h.typeKey("synthetic-openai-draft");
  pending.resolve({ provider: "ANTHROPIC", model: "stored-A", hasApiKey: true });
  await settle(); h.render();
  expect(h.button("OpenAI").props["aria-pressed"]).toBe(true);
  expect(h.password().props.value).toBe("synthetic-openai-draft");
  h.unmount();
});
it("a retired integration action never follows up against the old company using the new resource", async () => {
  const h = settingsHarness(); await h.mount(); await h.nav("navIntegrations");
  h.find((node: any) => node.type === "div" && node.props.onClick && JSON.stringify(node.props.children).includes("Fixture")).props.onClick();
  h.render();
  const pending = deferred(); h.pending.testIntegration = pending.promise;
  const action = h.button("m2f159920cfcf").props.onClick();
  h.company("company-B"); await settle(); h.render(); h.writes = [];
  const callsBefore = h.calls.filter((call: any[]) => call[0] === "listIntegrations").length;
  pending.resolve({ success: true }); await action;
  expect(h.writes).toEqual([]);
  expect(h.calls.filter((call: any[]) => call[0] === "listIntegrations")).toHaveLength(callsBefore);
  h.unmount();
});
