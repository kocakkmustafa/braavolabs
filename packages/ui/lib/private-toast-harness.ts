/** Actual page/Toast source with controlled hooks, not a DOM/browser renderer.
 * Store actions/session helpers and api/apiFetch are real; only fetch is mocked
 * by the regression fixture. No provider, API server or credential is needed. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as transport from "./api";
import * as auth from "./store";

export function privateToastHarness() {
  type Hooks = { states: any[]; refs: any[]; memos: any[]; effects: any[] };
  const h: any = { companyId: "company-a", writes: [], timers: new Map(), queuedWrites: [], deferWrites: false };
  const instances = new Map<string, Hooks>();
  let current = "", stateCursor = 0, refCursor = 0, memoCursor = 0, effectCursor = 0, timerId = 0;
  let pendingEffects: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((x, i) => Object.is(x, b[i]));
  const instance = () => instances.get(current)!;
  const hooks = {
    createContext(value: any) { const context: any = { value }; context.Provider = { context }; return context; },
    useContext(context: any) { return context.value; },
    useState(initial: any) {
      const owner = current, row = instance(), index = stateCursor++;
      if (!(index in row.states)) row.states[index] = typeof initial === "function" ? initial() : initial;
      return [row.states[index], (update: any) => {
        h.writes.push({ owner, index });
        const apply = () => { row.states[index] = typeof update === "function" ? update(row.states[index]) : update; };
        if (h.deferWrites) h.queuedWrites.push(apply); else apply();
      }];
    },
    useRef(initial: any) { return instance().refs[refCursor++] ??= { current: initial }; },
    useMemo(fn: any, deps: any[]) {
      const row = instance(), index = memoCursor++;
      if (!row.memos[index] || !same(row.memos[index].deps, deps)) row.memos[index] = { deps, value: fn() };
      return row.memos[index].value;
    },
    useCallback(fn: any, deps: any[]) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn: any, deps: any[]) {
      const row = instance(), index = effectCursor++;
      if (!row.effects[index] || !same(row.effects[index].deps, deps)) {
        pendingEffects.push(() => { row.effects[index]?.cleanup?.(); row.effects[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  const store = Object.assign((selector: any) => selector(auth.useAppStore.getState()), {
    getState: auth.useAppStore.getState, setState: auth.useAppStore.setState,
  });
  const element = (type: any, props: any) => {
    if (type?.context) type.context.value = props.value;
    return { type: type?.context ? "Context.Provider" : type, props: props ?? {} };
  };
  const cache = new Map<string, any>();
  const toastFile = resolve(process.cwd(), "components/Toast.tsx");
  function load(path: string): any {
    if (cache.has(path)) return cache.get(path);
    const mod = { exports: {} as any };
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const local = (name: string): any => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
      if (name === "next-intl") return { useTranslations: () => Object.assign(
        (key: string, values?: any) => values ? key + " " + JSON.stringify(values) : key,
        { rich: (key: string) => key },
      ) };
      if (name === "next/navigation") return { useParams: () => ({ id: h.companyId }) };
      if (name.endsWith("/store")) return { ...auth, useAppStore: store };
      if (name.endsWith("/api")) return transport;
      if (name.endsWith("/Toast")) return load(toastFile);
      if (name.endsWith("/useAuthGuard")) return { useAuthGuard: () => ({ token: auth.useAppStore.getState().token, hydrated: true }) };
      return { default: () => null };
    };
    runInNewContext("(function(require,module,exports){" + code + "\n})", {
      Error, console,
      setTimeout: (fn: any) => { const id = ++timerId; h.timers.set(id, fn); return id; },
      clearTimeout: (id: number) => h.timers.delete(id),
    })(local, mod, mod.exports);
    cache.set(path, mod.exports); return mod.exports;
  }
  const toast = load(toastFile), Page = load(resolve(process.cwd(), "app/companies/[id]/page.tsx")).default;
  function renderInstance(name: string, render: () => any) {
    current = name;
    if (!instances.has(name)) instances.set(name, { states: [], refs: [], memos: [], effects: [] });
    stateCursor = refCursor = memoCursor = effectCursor = 0;
    return render();
  }
  function walk(node: any, test: (node: any) => boolean): any {
    if (Array.isArray(node)) { for (const child of node) { const found = walk(child, test); if (found) return found; } return; }
    if (!node || typeof node !== "object") return;
    if (test(node)) return node;
    return walk(node.props?.children, test);
  }
  h.flushEffects = () => { const effects = pendingEffects; pendingEffects = []; effects.forEach(effect => effect()); };
  h.flushWrites = () => { const updates = h.queuedWrites; h.queuedWrites = []; updates.forEach((apply: any) => apply()); };
  h.render = (commitEffects = true, includePage = true) => {
    h.toastTree = renderInstance("provider", () => toast.ToastProvider({ children: null }));
    h.toast = renderInstance("caller", () => toast.useToast()).toast;
    if (includePage) h.tree = renderInstance("page", () => Page());
    if (commitEffects) h.flushEffects();
  };
  h.find = (test: (node: any) => boolean) => {
    const found = walk(h.tree, test); if (!found) throw new Error("Missing actual page control"); return found;
  };
  h.maybe = (test: (node: any) => boolean) => walk(h.tree, test);
  const hasLabel = (node: any, key: string): boolean => node === key || (Array.isArray(node)
    ? node.some(child => hasLabel(child, key)) : Boolean(node?.props && hasLabel(node.props.children, key)));
  h.button = (key: string) => h.find((node: any) => node.type === "button" && hasLabel(node.props.children, key));
  const expandAgent = () => {
    if (!walk(h.tree, node => typeof node.type === "function" && node.type.name === "AutonomySegmented")) {
      h.find((node: any) => node.type === "div" && node.props.className === "bv-glass" && node.props.onClick).props.onClick(); h.render();
    }
  };
  h.openComposer = (input = "Synthetic private description") => {
    h.button("app.companyDetail.composeWithAi").props.onClick(); h.render();
    h.find((node: any) => node.type === "textarea").props.onChange({ target: { value: input } }); h.render();
    return h.find((node: any) => node.type === "button" && node.props.onClick?.name === "handleCompose").props.onClick;
  };
  h.modelAction = (model = "synthetic-new-model") => {
    expandAgent();
    if (!walk(h.tree, node => node.type === "input" && node.props.list)) {
      h.button("app.companyDetail.editLabel").props.onClick({ stopPropagation() {} }); h.render();
    }
    h.find((node: any) => node.type === "input" && node.props.list).props.onChange({ target: { value: model } }); h.render();
    return h.button("app.companyDetail.save").props.onClick;
  };
  h.autonomyAction = () => {
    expandAgent();
    const control = h.find((node: any) => typeof node.type === "function" && node.type.name === "AutonomySegmented");
    return () => control.props.onChange("AUTONOMOUS");
  };
  h.text = () => JSON.stringify(h.tree);
  h.toastText = () => JSON.stringify(h.toastTree);
  h.retainedToasts = () => instances.get("provider")!.states[0];
  h.retainedPage = () => instances.get("page")!.states;
  h.expandAgentByName = (name: string) => {
    h.find((node: any) => node.type === "div" && node.props.className === "bv-glass" && node.props.onClick
      && hasLabel(node.props.children, name.toLowerCase())).props.onClick();
    h.render();
  };
  h.unmountPage = () => instances.get("page")?.effects.forEach(effect => effect?.cleanup?.());
  h.dispose = () => { instances.forEach(row => row.effects.forEach(effect => effect?.cleanup?.())); pendingEffects = []; };
  return h;
}
