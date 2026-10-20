/** Actual production form handlers and helpers, transpiled with controlled hook,
 * store, API and timer boundaries. No DOM, React renderer or browser claim. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseCompareOptions, parseCompareSession } from "./compare";

export function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
export async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
export function compareHarness(file = resolve(process.cwd(), "components/ComparePanel.tsx")) {
  const h: any = {states: [], refs: [], memos: [], effects: [], calls: [], writes: [], timers: new Map(),
    companyId: "company-a", session: {revision: 1, tenantId: "tenant-a", token: "synthetic-a"},
    options: {companyId: "company-a", maxCandidates: 3, selections: [
      {provider: "DEEPSEEK", model: "deepseek-chat", reasoningEfforts: []},
      {provider: "OPENAI", model: "gpt-4o", reasoningEfforts: []},
      {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"]},
    ]}, start: {id: "session-a", status: "PENDING"},
    result: {id: "session-a", companyId: "company-a", status: "COMPLETED", findings: {multiModel: {
      perModel: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high", answer: "synthetic candidate"}],
      failed: [], finalAnswer: "synthetic final", synthesisStatus: "structured", synthesizer: {provider: "DEEPSEEK", model: "deepseek-chat"},
    }}}};
  let stateCursor = 0, refCursor = 0, memoCursor = 0, effectCursor = 0, nextTimer = 1;
  let pendingEffects: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((x, i) => Object.is(x, b[i]));
  const hooks = {
    useState(initial: any) { const i = stateCursor++; if (!(i in h.states)) h.states[i] = typeof initial === "function" ? initial() : initial;
      return [h.states[i], (value: any) => { h.writes.push(i); h.states[i] = typeof value === "function" ? value(h.states[i]) : value; }]; },
    useRef(initial: any) { return h.refs[refCursor++] ??= {current: initial}; },
    useMemo(fn: any, deps: any[]) { const i = memoCursor++; if (!h.memos[i] || !same(h.memos[i].deps, deps)) h.memos[i] = {deps, value: fn()}; return h.memos[i].value; },
    useEffect(fn: any, deps: any[]) { const i = effectCursor++; if (!h.effects[i] || !same(h.effects[i].deps, deps)) {
      pendingEffects.push(() => { h.effects[i]?.cleanup?.(); h.effects[i] = {deps, cleanup: fn()}; });
    } },
  };
  const state = () => ({...h.session, sessionRevision: h.session.revision, _hydrated: true});
  const store = Object.assign((selector: any) => selector(state()), {getState: state});
  const current = (owner: any) => owner.revision === h.session.revision && owner.tenantId === h.session.tenantId;
  const api = {
    compareOptions: async (...args: any[]) => { h.calls.push(["options", ...args]); return parseCompareOptions(await (h.pendingOptions?.promise ?? h.options), args[1]); },
    startSelectedCompare: async (...args: any[]) => { h.calls.push(["post", args[0], JSON.parse(JSON.stringify(args[1])), args[2]]);
      const value = await (h.pendingStart?.promise ?? h.start);
      if (!value?.id || value.status !== "PENDING") throw new Error("Invalid compare start response"); return value; },
    compareSession: async (...args: any[]) => { h.calls.push(["poll", ...args]);
      return parseCompareSession(await (h.pendingPoll?.promise ?? h.result), args[1], args[2]); },
    getCompany: async (...args: any[]) => { h.calls.push(["company", ...args]); return await (h.pendingCompany?.promise ?? {id: h.companyId, name: "Synthetic", status: "ACTIVE", agents: [], pipelines: []}); },
  };
  const element = (type: any, props: any) => ({type, props: props ?? {}});
  const cache = new Map<string, any>();
  function load(path: string): any {
    if (cache.has(path)) return cache.get(path);
    const mod = {exports: {} as any};
    const code = ts.transpileModule(readFileSync(path, "utf8"), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
    const local = (name: string): any => {
      if (name === "react") return hooks;
      if (/\/(localized-error|useDisplayFormats|useStateLabel|i18n\/locales)$/.test(name)) return load(resolve(dirname(path), name + ".ts"));
      if (name === "react/jsx-runtime") return {jsx: element, jsxs: element, Fragment: "Fragment"};
      if (name === "next-intl") return {useLocale: () => "en", useTranslations: () => Object.assign((key: string) => key, {rich: (key: string) => key})};
      if (name === "next/navigation") return {useParams: () => ({id: h.companyId})};
      if (name.endsWith("/useAuthGuard")) return {useAuthGuard: () => ({token: h.session.token, hydrated: true})};
      if (name.endsWith("/Toast")) return {useToast: () => ({toast() {}})};
      if (name.endsWith("/api")) return {api};
      if (name.endsWith("/store")) return {useAppStore: store, captureAuthSession: () => ({...h.session}), isAuthSessionCurrent: current};
      if (name.endsWith("/compare")) return load(resolve(dirname(path), name + ".ts"));
      return {default: () => null};
    };
    runInNewContext("(function(require,module,exports){" + code + "\n})", {
      AbortController, DOMException, Error, console,
      setTimeout: (fn: any) => { const id = nextTimer++; h.timers.set(id, fn); return id; },
      clearTimeout: (id: number) => h.timers.delete(id),
    })(local, mod, mod.exports);
    cache.set(path, mod.exports); return mod.exports;
  }
  const Component = load(file).default;
  function walk(node: any, test: (node: any) => boolean): any {
    if (Array.isArray(node)) { for (const child of node) { const found = walk(child, test); if (found) return found; } return; }
    if (!node || typeof node !== "object") return;
    if (test(node)) return node;
    return walk(node.props?.children, test);
  }
  h.flushEffects = () => { const effects = pendingEffects; pendingEffects = []; effects.forEach(effect => effect()); };
  // Observe actual render output before effect cleanup or new effects commit.
  h.render = (commitEffects = true) => { stateCursor = refCursor = memoCursor = effectCursor = 0; h.tree = Component({companyId: h.companyId}); if (commitEffects) h.flushEffects(); return h.tree; };
  h.mount = async () => { h.render(); await settle(); h.render(); h.writes = []; };
  h.find = (type: string, label?: string) => { const node = walk(h.tree, n => n.type === type && (!label || n.props["aria-label"] === label || n.props.children === label)); if (!node) throw new Error(`Missing actual ${type}: ${label}`); return node; };
  h.change = (type: string, label: string, value: string) => { h.find(type, label).props.onChange({target: {value}}); h.render(); };
  h.click = (label: string) => { const result = h.find("button", label).props.onClick(); h.render(); return result; };
  h.query = (value = "Synthetic question for comparison") => h.change("textarea", "query", value);
  h.add = (provider = "CEREBRAS", model = "gpt-oss-120b") => h.change("select", "addModel", JSON.stringify([provider, model]));
  h.effort = (value: string) => h.change("select", "effort CEREBRAS / gpt-oss-120b", value);
  h.submit = () => h.find("form").props.onSubmit({preventDefault() {}});
  h.fireTimers = async () => { const timers = [...h.timers.entries()]; for (const [id, fn] of timers) { h.timers.delete(id); fn(); } await settle(); h.render(); };
  h.posts = () => h.calls.filter((call: any[]) => call[0] === "post");
  h.polls = () => h.calls.filter((call: any[]) => call[0] === "poll");
  h.view = () => h.states[0];
  h.text = () => JSON.stringify(h.tree);
  h.unmount = () => { h.effects.forEach((effect: any) => effect?.cleanup?.()); };
  return h;
}
