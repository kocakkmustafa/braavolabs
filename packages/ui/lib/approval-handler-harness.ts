/** Executes the actual TSX event-handler source with deterministic hook/native
 * boundaries. This is handler unit evidence, not React rendering or device proof. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export function screenHarness(file: string, surface: "web" | "mobile", screen: "queue" | "dashboard" = "queue") {
  const h: any = { states: [], refs: [], effects: [], memos: [], calls: [], feedback: [], alerts: [], mounted: true,
    session: { token: "synthetic-token", tenantId: "synthetic-tenant", revision: 1, generation: 1, userId: "synthetic-user" },
    response: { success: true, decision: "APPROVED" }, polls: [],
    row: { id: "synthetic-approval", status: "PENDING", type: "HANDOFF", description: "Synthetic takeover", reason: "Synthetic takeover", runId: "synthetic-run", createdAt: "2026-10-06T00:00:00Z", amountUsd: null, costUsd: 0, payload: {}, artifact: null } };
  let stateCursor = 0, refCursor = 0, effectCursor = 0, memoCursor = 0;
  const state = () => ({ ...h.session, sessionGeneration: h.session.generation, sessionRevision: h.session.revision,
    _hydrated: true, user: { id: h.session.userId } });
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((x, i) => Object.is(x, b[i]));
  const hooks = {
    useState(initial: any) {
      const i = stateCursor++;
      if (!(i in h.states)) h.states[i] = typeof initial === "function" ? initial() : initial;
      return [h.states[i], (next: any) => { h.calls.push(["state", i]); h.states[i] = typeof next === "function" ? next(h.states[i]) : next; }];
    },
    useRef(initial: any) { const i = refCursor++; return h.refs[i] ??= { current: initial }; },
    useCallback(fn: any) { return fn; },
    useMemo(fn: any, deps: any[]) { const i = memoCursor++; if (!h.memos[i] || !same(h.memos[i].deps, deps)) h.memos[i] = { deps, value: fn() }; return h.memos[i].value; },
    useEffect(fn: any, deps: any[]) {
      const i = effectCursor++;
      if (!h.effects[i] || !same(h.effects[i].deps, deps)) {
        h.effects[i]?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() };
      }
    },
  };
  const element = (type: any, props: any) => ({ type, props: props ?? {} });
  const t = (key: string, args?: any) => key + (args?.reason ? ": " + args.reason : "");
  const current = (snap: any) => snap.revision === h.session.revision && snap.generation === h.session.generation && snap.tenantId === h.session.tenantId && snap.userId === h.session.userId;
  const store = Object.assign((selector: any) => selector(state()), { getState: state });
  const api: any = {
    decideApproval: async (...args: any[]) => { h.calls.push(["post", ...args]); if (h.reject) throw h.reject; return await (h.pending ?? h.response); },
    listApprovals: async () => [h.row], health: async () => ({}), usage: async () => ({}), finance: async () => ({}),
    listCompanies: async () => [], activityLog: async () => ({ logs: [] }), me: async () => ({ tenant: { plan: "TRIAL" } }), listRuns: async () => ({ runs: [] }),
  };
  const placeholder = new Proxy({ default: () => null }, { get: (obj: any, key: any) => key in obj ? obj[key] : () => null });
  const cache = new Map<string, any>();
  function load(path: string): any {
    if (cache.has(path)) return cache.get(path);
    const mod = { exports: {} as any }; cache.set(path, mod.exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const requireLocal = (name: string): any => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
      if (name === "next-intl") return { useTranslations: () => t };
      if (name === "react-native") return new Proxy({ Alert: { alert: (...args: any[]) => h.alerts.push(args) }, useWindowDimensions: () => ({ fontScale: 1 }) }, { get: (obj: any, k: any) => k in obj ? obj[k] : String(k) });
      if (name === "expo-haptics") return { NotificationFeedbackType: { Success: "success", Error: "error" }, notificationAsync: (kind: string) => { h.feedback.push(kind); }, impactAsync() {}, selectionAsync() {} };
      if (name === "expo-router") return { useRouter: () => ({ push() {}, replace() {} }) };
      if (name.endsWith("/api")) return { api, isCanonicalPaidPlan: () => false };
      if (name.endsWith("/store")) return { useAppStore: store, captureAuthSession: () => ({ ...h.session }), getAuthSessionSnapshot: () => ({ ...h.session }), isAuthSessionCurrent: current };
      if (name.endsWith("/useAuthGuard")) return { useAuthGuard: () => ({ token: h.session.token, hydrated: true }) };
      if (name.endsWith("/useTheme")) return { useTheme: () => ({ colors: new Proxy({}, { get: () => "#222222" }) }) };
      if (name.endsWith("/i18n")) return { useT: () => t, t, errorMessage: (error: any, fallback: string) => error?.message ?? fallback };
      if (name.endsWith("/sounds")) return { sounds: { success: () => h.feedback.push("success"), click: () => h.feedback.push("click"), error: () => h.feedback.push("error") } };
      if (name.endsWith("/offlineFallback")) return { withOfflineFallback: async (fn: any) => h.offlineDeclined ? { ran: false } : { ran: true, result: await fn() } };
      if (name.endsWith("/useFocusPoll")) return { useFocusPoll: (fn: any) => { h.polls = [fn]; return { lastUpdated: null }; } };
      if (name.endsWith("/activity")) return { filterActivity: (rows: any) => rows };
      if (name.endsWith("/format")) return new Proxy({ currency: () => "$0" }, { get: (obj: any, key: any) => key in obj ? obj[key] : () => "U" });
      if (name.endsWith("/theme")) return { radii: {} };
      // These are production decision modules, deliberately NOT mocked.
      if (/\/(approvalDecision|useApprovalDecision)$/.test(name)) {
        const absolute = resolve(dirname(path), name + ".ts");
        if (!existsSync(absolute)) throw new Error("Missing production helper: " + absolute);
        return load(absolute);
      }
      return placeholder;
    };
    runInNewContext("(function(require,module,exports){" + code + "\n})", { console })(requireLocal, mod, mod.exports);
    cache.set(path, mod.exports); return mod.exports;
  }
  const Component = load(file).default;
  function walk(node: any, fn: (n: any) => boolean): any {
    if (!node) return;
    if (Array.isArray(node)) { for (const child of node) { const found = walk(child, fn); if (found) return found; } return; }
    if (typeof node !== "object") return;
    if (fn(node)) return node;
    return walk(node.props?.children, fn);
  }
  h.render = () => { stateCursor = refCursor = effectCursor = memoCursor = 0; h.tree = Component(); return h.tree; };
  h.mount = async () => {
    h.render();
    if (surface === "web") {
      // First effect is the actual queue load; settle its promise callbacks.
      await Promise.resolve(); await Promise.resolve();
    } else await h.polls[0]();
    h.render(); h.calls = []; h.feedback = []; h.alerts = [];
  };
  h.decide = (decision = "APPROVED") => {
    if (surface === "web") {
      const button = walk(h.tree, (n) => n.type === "button" && n.props?.onClick && JSON.stringify(n.props.children).includes(decision === "APPROVED" ? "app.approvals.approve" : "app.approvals.reject"));
      if (!button) throw new Error("Actual approval button not found");
      return button.props.onClick();
    }
    const card = walk(h.tree, (n) => n.props?.approval?.id === h.row.id);
    if (!card) throw new Error("Actual approval card not found");
    if (screen === "queue") card.props.onDecide(decision);
    else (decision === "APPROVED" ? card.props.onApprove : card.props.onDeny)(h.row.id);
    const dialog = h.alerts.at(-1);
    return dialog[2].find((b: any) => b.onPress && b.style !== "cancel").onPress();
  };
  h.postCount = () => h.calls.filter((c: any[]) => c[0] === "post").length;
  h.rows = () => h.states.filter(Array.isArray).flat().filter((r: any) => r?.id === h.row.id);
  h.text = () => JSON.stringify([h.states.filter((s: any) => typeof s === "string"), h.alerts]);
  h.unmount = () => { h.mounted = false; for (const effect of h.effects) effect?.cleanup?.(); };
  return h;
}
