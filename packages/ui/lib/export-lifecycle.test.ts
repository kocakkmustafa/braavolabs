/** Actual export component handlers with controlled hooks and clipboard.
 * This verifies async admission and feedback, not a DOM/browser or OS permission. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { deferred, settle } from "./compare-handler-harness";

function harness() {
  const h: any = { states: [], refs: [], effects: [], timers: new Map(), writes: [],
    session: { revision: 1, tenantId: "synthetic-a" }, clipboard: vi.fn(),
    bundle: { claudeMd: "Synthetic private A", skills: [], hooks: [], company: { name: "Synthetic", slug: "synthetic" } } };
  let state = 0, ref = 0, effect = 0, timer = 0, pending: (() => void)[] = [];
  const current = (owner: any) => h.session.revision === owner.revision && h.session.tenantId === owner.tenantId;
  const hooks = {
    useState(initial: any) { const i = state++; if (!(i in h.states)) h.states[i] = initial;
      return [h.states[i], (value: any) => { h.writes.push(i); h.states[i] = typeof value === "function" ? value(h.states[i]) : value; }]; },
    useRef(initial: any) { return h.refs[ref++] ??= { current: initial }; },
    useEffect(fn: any, deps: any[]) { const i = effect++;
      if (!h.effects[i] || !deps.every((value, index) => Object.is(value, h.effects[i].deps[index])))
        pending.push(() => { h.effects[i]?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() }; });
    },
  };
  const element = (type: any, props: any) => ({ type, props: props ?? {} });
  const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "app/companies/[id]/export/page.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText + "\nexports.FixtureContent = ExportPageContent;";
  const exports: any = {};
  runInNewContext(code, { exports, navigator: { clipboard: { writeText: (text: string) => h.clipboard(text) } },
    setTimeout: (fn: any) => { h.timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => h.timers.delete(id),
    require: (name: string) => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
      if (name === "next/navigation") return { useParams: () => ({ id: "synthetic-company" }) };
      if (name === "next-intl") return { useTranslations: () => (key: string) => key };
      if (name.endsWith("/useAuthGuard")) return { useAuthGuard: () => ({ token: "synthetic-token", hydrated: true }) };
      if (name.endsWith("/store")) return { captureAuthSession: () => ({ ...h.session }), isAuthSessionCurrent: current };
      if (name.endsWith("/api")) return { api: { exportBundle: async () => h.bundle } };
      throw new Error(`Unexpected boundary ${name}`);
    },
  });
  const walk = (node: any, predicate: (node: any) => boolean): any => {
    if (Array.isArray(node)) { for (const child of node) { const found = walk(child, predicate); if (found) return found; } return; }
    if (!node || typeof node !== "object") return;
    return predicate(node) ? node : walk(node.props?.children, predicate);
  };
  h.render = () => { state = ref = effect = 0; h.tree = exports.FixtureContent(); const todo = pending; pending = []; todo.forEach(fn => fn()); };
  h.button = (label: string) => { const node = walk(h.tree, n => n.type === "button" && JSON.stringify(n.props.children).includes(label)); if (!node) throw new Error(`Missing control ${label}`); return node.props.onClick; };
  h.text = () => JSON.stringify(h.tree);
  h.mount = async () => { h.render(); await settle(); h.render(); h.writes = []; };
  return h;
}

describe("actual export clipboard feedback and owner admission", () => {
  it("reports success only after the clipboard promise succeeds", async () => {
    const h = harness(); await h.mount(); const pending = deferred(); h.clipboard.mockReturnValue(pending.promise);
    const action = h.button("app.exportBundle.copy")(); h.render();
    expect(h.text()).not.toContain("app.exportBundle.copied");
    pending.resolve(undefined); await action; h.render();
    expect(h.text()).toContain("app.exportBundle.copied");
  });
  it("shows a recoverable failure without claiming copied when permission rejects", async () => {
    const h = harness(); await h.mount(); h.clipboard.mockRejectedValue(new Error("Synthetic clipboard denial"));
    await h.button("app.exportBundle.copy")(); h.render();
    expect(h.text()).toContain("app.exportBundle.copyFailed");
    expect(h.text()).not.toContain("app.exportBundle.copied");
  });
  it("retires a late clipboard success on an owner change", async () => {
    const h = harness(); await h.mount(); const pending = deferred(); h.clipboard.mockReturnValue(pending.promise);
    const action = h.button("app.exportBundle.copy")(); h.writes = [];
    h.session = { revision: 2, tenantId: "synthetic-b" }; pending.resolve(undefined); await action;
    expect(h.writes).toEqual([]); expect(h.timers.size).toBe(0);
  });
  it("does not copy old-owner data from a retained callback after logout", async () => {
    const h = harness(); await h.mount(); const action = h.button("app.exportBundle.copy");
    h.session = { revision: 2, tenantId: null }; await action();
    expect(h.clipboard).not.toHaveBeenCalled();
  });
  it("retires pending copy feedback when the selected format changes", async () => {
    const h = harness(); await h.mount(); const pending = deferred(); h.clipboard.mockReturnValue(pending.promise);
    const action = h.button("app.exportBundle.copy")(); h.button("app.exportBundle.fmtGeneric")(); h.render(); await settle(); h.writes = [];
    pending.resolve(undefined); await action; expect(h.writes).toEqual([]); expect(h.timers.size).toBe(0);
  });
});
