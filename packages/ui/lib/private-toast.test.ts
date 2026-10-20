import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, SessionChangedError } from "./api";
import { captureAuthSession, refreshAuthSession, useAppStore } from "./store";
import { deferred, settle } from "./compare-handler-harness";
import { privateToastHarness } from "./private-toast-harness";

// No real API/HTTP/provider traffic: every fetch is intercepted, and unknown
// paths fail. The store and transport/session checks are the production code.
const response = (body: unknown, status = 200): Response => ({
  ok: status < 400, status, json: async () => body,
} as Response);
const company = (id = "company-a") => ({
  id, name: "Synthetic " + id, status: "ACTIVE", agents: [{
    id: "agent-" + id, name: "Synthetic agent", role: "Synthetic role", model: "synthetic-model",
    autonomy: "SUPERVISED", tools: [],
  }], pipelines: [],
});
const composed = { agent: { id: "new-agent", name: "PRIVATE_COMPOSE_NAME_A", role: "synthetic" },
  droppedTools: [], provider: "OPENAI", model: "gpt-4o", tokens: { input: 0, output: 0 } };
type Gate = ReturnType<typeof deferred<Response>>;
let h: ReturnType<typeof privateToastHarness>;
const fetchSpy = vi.fn();
let mutations: Gate[], companyReads: Gate[];
const requests = () => fetchSpy.mock.calls.map(([url, options]) => ({
  path: new URL(String(url), "https://fixture.invalid").pathname,
  method: options.method ?? "GET", token: new Headers(options.headers).get("Authorization"),
}));
const mutationCount = () => requests().filter(request => request.method === "PATCH" || request.path.endsWith("/agents/compose")).length;
const newOwner = (kind: "logout" | "tenant" | "login") => {
  if (kind === "logout") useAppStore.getState().clearAuth();
  else useAppStore.getState().setAuth("synthetic-new-login", kind === "tenant" ? "tenant-b" : "tenant-a", "synthetic-new-refresh");
};
const rotate = () => expect(refreshAuthSession(captureAuthSession(), "synthetic-rotated", "tenant-a", "synthetic-rotated-refresh")).toBe(true);
async function mount() { h.render(); await settle(); h.render(); h.writes = []; }
const action = (kind: "model" | "autonomy" | "compose") => kind === "model" ? h.modelAction()
  : kind === "autonomy" ? h.autonomyAction() : h.openComposer();
const feedbackBusy = (kind: "model" | "autonomy" | "compose") => kind === "model"
  ? Boolean(h.maybe((node: any) => node.type === "input" && node.props.list)?.props.disabled)
  : kind === "autonomy"
    ? h.find((node: any) => typeof node.type === "function" && node.type.name === "AutonomySegmented").props.disabled
    : h.find((node: any) => node.type === "textarea").props.disabled;

beforeEach(() => {
  const memoryStorage = () => {
    const entries = new Map<string, string>();
    return { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) };
  };
  vi.stubGlobal("localStorage", memoryStorage()); vi.stubGlobal("sessionStorage", memoryStorage());
  useAppStore.getState().setAuth("synthetic-a", "tenant-a", "synthetic-refresh-a");
  useAppStore.setState({ _hydrated: true });
  mutations = []; companyReads = []; fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (url, options) => {
    const path = new URL(String(url), "https://fixture.invalid").pathname;
    if (path.endsWith("/auth/logout")) return response(undefined, 204);
    if (path.endsWith("/auth/refresh")) return response({
      token: "synthetic-rotated", refreshToken: "synthetic-rotated-refresh", tenant: { id: "tenant-a" },
    });
    if (path.endsWith("/agents/compose") || options.method === "PATCH") {
      return mutations.shift()?.promise ?? response(path.endsWith("/agents/compose") ? composed : {});
    }
    const match = path.match(/\/companies\/(company-[ab])$/);
    if (match) return companyReads.shift()?.promise ?? response(company(match[1]));
    throw new Error("Unexpected synthetic fetch: " + path);
  });
  vi.stubGlobal("fetch", fetchSpy);
  h = privateToastHarness();
});
afterEach(() => { h.dispose(); useAppStore.getState().clearAuth(); vi.unstubAllGlobals(); });

describe("actual root toast owner boundary before passive effects", () => {
  it.each(["logout", "tenant", "login"] as const)("hides a queued private message on %s in the first render", kind => {
    h.render(); h.toast("PRIVATE_ALREADY_QUEUED_A", "success"); h.render();
    expect(h.toastText()).toContain("PRIVATE_ALREADY_QUEUED_A");
    newOwner(kind); h.writes = []; h.render(false, false);
    expect(h.writes).toEqual([]); expect(h.toastText()).not.toContain("PRIVATE_ALREADY_QUEUED_A");
    h.flushEffects(); h.render(false, false);
    expect(h.toastText()).not.toContain("PRIVATE_ALREADY_QUEUED_A");
  });
  it("rejects a stale caller even before another render", () => {
    h.render(); const staleToast = h.toast; newOwner("login"); h.writes = [];
    staleToast("PRIVATE_LATE_CALLBACK_A", "error", 6000);
    expect(h.writes).toEqual([]); h.render(false, false);
    expect(h.toastText()).not.toContain("PRIVATE_LATE_CALLBACK_A");
  });
  it("rechecks ownership inside an already queued functional updater", () => {
    h.render(); h.deferWrites = true; h.toast("PRIVATE_QUEUED_UPDATER_A");
    expect(h.queuedWrites).toHaveLength(1); newOwner("tenant"); h.flushWrites(); h.deferWrites = false;
    h.render(false, false); expect(h.toastText()).not.toContain("PRIVATE_QUEUED_UPDATER_A");
    // Inspect the provider's actual retained records, not merely hidden text.
    expect(h.retainedToasts()).toEqual([]);
  });
  it("same-owner refresh preserves queued messages and the initiating callback", () => {
    h.render(); const toast = h.toast; toast("PRIVATE_REFRESH_CONTROL_A"); h.render(); rotate();
    h.writes = []; h.render(false, false);
    expect(h.writes).toEqual([]); expect(h.toastText()).toContain("PRIVATE_REFRESH_CONTROL_A");
    toast("PRIVATE_REFRESH_CALLBACK_A"); h.render(false, false);
    expect(h.toastText()).toContain("PRIVATE_REFRESH_CALLBACK_A");
  });
  it("keeps public/login messages useful across auth transitions", () => {
    useAppStore.getState().clearAuth(); h.render(); const publicToast = h.toast;
    publicToast("PUBLIC_LOGIN_HELP"); h.render(); newOwner("login"); h.render(false, false);
    expect(h.toastText()).toContain("PUBLIC_LOGIN_HELP"); publicToast("PUBLIC_HELP_CALLBACK");
    h.render(false, false); expect(h.toastText()).toContain("PUBLIC_HELP_CALLBACK");
  });
  it("real signOut clears an already queued private compose-success toast before logout completes", async () => {
    await mount(); await h.openComposer()(); h.render();
    expect(h.toastText()).toContain("PRIVATE_COMPOSE_NAME_A");
    const logout = deferred<Response>(); fetchSpy.mockImplementationOnce(() => logout.promise);
    const signout = api.signOut(); expect(useAppStore.getState().token).toBeNull();
    h.writes = []; h.render(false, false);
    expect(h.writes).toEqual([]); expect(h.toastText()).not.toContain("PRIVATE_COMPOSE_NAME_A");
    logout.resolve(response(undefined, 204)); await signout;
  });
});

describe("actual company action callbacks with real apiFetch ownership checks", () => {
  it("actual two-agent autonomy controls are visibly disabled during the serial save", async () => {
    const twoAgents = company(); twoAgents.agents.push({ ...twoAgents.agents[0], id: "agent-second", name: "Second synthetic agent" });
    const load = deferred<Response>(); companyReads.push(load); h.render(); load.resolve(response(twoAgents)); await settle(); h.render();
    const gate = deferred<Response>(); mutations.push(gate); const first = h.autonomyAction()(); h.render();
    h.expandAgentByName("Second synthetic agent");
    const second = h.find((node: any) => typeof node.type === "function" && node.type.name === "AutonomySegmented");
    expect(second.props.disabled).toBe(true);
    await second.props.onChange("AUTONOMOUS"); expect(mutationCount()).toBe(1);
    gate.resolve(response({})); await first; h.render();
    const enabled = h.find((node: any) => typeof node.type === "function" && node.type.name === "AutonomySegmented");
    expect(enabled.props.disabled).toBe(false); await enabled.props.onChange("AUTONOMOUS");
    expect(mutationCount()).toBe(2);
  });
  for (const kind of ["model", "autonomy", "compose"] as const) {
    for (const retirement of ["logout", "tenant", "login", "company", "unmount"] as const) {
      it(`${kind} retires success/catch/finally on ${retirement} without stale writes or toast`, async () => {
        await mount(); const old = deferred<Response>(); mutations.push(old);
        const run = action(kind)(); await settle(); expect(mutationCount()).toBe(1);
        if (retirement === "unmount") h.unmountPage();
        else if (retirement === "company") { h.companyId = "company-b"; h.render(false); }
        else newOwner(retirement); // Auth guard must work even before rerender.
        h.writes = []; const fetches = fetchSpy.mock.calls.length;
        old.resolve(response(kind === "compose" ? composed : {})); await run; await settle();
        expect(h.writes).toEqual([]); expect(fetchSpy.mock.calls.length).toBe(fetches);
        h.render(false, false); expect(h.toastText()).not.toContain("PRIVATE_COMPOSE_NAME_A");
        expect(h.toastText()).not.toContain("Session changed while");
      });
    }
    it(`${kind} late API error-body ownership check cannot enqueue or release a new owner's latch`, async () => {
      await mount(); const errorBody = deferred<any>(); const old = deferred<Response>(); mutations.push(old);
      const oldRun = action(kind)();
      old.resolve({ ok: false, status: 400, json: () => errorBody.promise } as Response); await settle();
      newOwner("login"); h.render(); await settle(); h.render();
      const next = deferred<Response>(); mutations.push(next); const newRun = action(kind)(); h.render();
      expect(feedbackBusy(kind)).toBe(true); expect(mutationCount()).toBe(2);
      h.writes = []; errorBody.resolve({ message: "PRIVATE_ERROR_BODY_A" }); await oldRun; await settle();
      expect(h.writes).toEqual([]); h.render(); expect(feedbackBusy(kind)).toBe(true);
      expect(h.toastText()).not.toContain("PRIVATE_ERROR_BODY_A"); expect(h.toastText()).not.toContain("Session changed while");
      next.resolve(response(kind === "compose" ? composed : {})); await newRun; h.render();
      expect(feedbackBusy(kind)).toBe(false);
    });
    it(`${kind} current-owner error is retained and its latch is released`, async () => {
      await mount(); const gate = deferred<Response>(); mutations.push(gate); const run = action(kind)();
      gate.resolve(response({ message: "CURRENT_PRIVATE_ERROR" }, 400)); await run; h.render();
      expect(h.toastText()).toContain("CURRENT_PRIVATE_ERROR"); expect(feedbackBusy(kind)).toBe(false);
      if (kind !== "autonomy") expect(h.text()).toContain("CURRENT_PRIVATE_ERROR");
      else expect(h.find((node: any) => typeof node.type === "function" && node.type.name === "AutonomySegmented").props.value).toBe("SUPERVISED");
    });
    it(`${kind} duplicate callbacks share one mutation before render`, async () => {
      await mount(); const gate = deferred<Response>(); mutations.push(gate); const submit = action(kind);
      const first = submit(), second = submit(); expect(mutationCount()).toBe(1);
      gate.resolve(response(kind === "compose" ? composed : {})); await Promise.all([first, second]);
    });
    it(`${kind} rejects an old initiation callback before any fetch or state write`, async () => {
      await mount(); const submit = action(kind); newOwner("login"); h.writes = [];
      const before = fetchSpy.mock.calls.length; await submit();
      expect(fetchSpy.mock.calls.length).toBe(before); expect(h.writes).toEqual([]);
    });
    it(`${kind} same-owner refresh before an old render callback uses the current token`, async () => {
      await mount(); const submit = action(kind); rotate(); await submit(); h.render();
      const mutation = requests().find(request => request.method === "PATCH" || request.path.endsWith("/agents/compose"));
      expect(mutation?.token).toBe("Bearer synthetic-rotated");
      expect(h.toastText()).not.toContain("Session changed while");
      expect(h.toastText()).toContain(kind === "compose" ? "PRIVATE_COMPOSE_NAME_A" : kind === "model" ? "modelUpdated" : "app.autonomy.saved");
    });
    it(`${kind} real 401 refresh retains the action and uses the new token on follow-up reads`, async () => {
      await mount(); const gate = deferred<Response>(); mutations.push(gate);
      const revision = captureAuthSession().revision; const run = action(kind)(); gate.resolve(response({}, 401));
      await run; h.render(); expect(captureAuthSession().revision).toBe(revision);
      expect(useAppStore.getState().token).toBe("synthetic-rotated");
      expect(h.toastText()).not.toContain("Session changed while"); expect(feedbackBusy(kind)).toBe(false);
      const afterRefresh = requests().slice(requests().findIndex(request => request.path.endsWith("/auth/refresh")) + 1);
      expect(afterRefresh.length).toBe(kind === "autonomy" ? 1 : 2);
      expect(afterRefresh.every(request => request.token === "Bearer synthetic-rotated")).toBe(true);
      expect(h.toastText()).toContain(kind === "compose" ? "PRIVATE_COMPOSE_NAME_A" : kind === "model" ? "modelUpdated" : "app.autonomy.saved");
    });
  }
  it.each(["model", "compose"] as const)("%s retires while its follow-up company JSON is pending", async kind => {
    await mount(); const body = deferred<any>(); companyReads.push({ promise: Promise.resolve({
      ok: true, status: 200, json: () => body.promise,
    } as Response) } as Gate);
    const run = action(kind)(); await settle(); newOwner("tenant"); h.writes = [];
    body.resolve(company()); await run; expect(h.writes).toEqual([]);
    h.render(false, false); expect(h.toastText()).not.toContain("PRIVATE_COMPOSE_NAME_A");
  });
  it("the real transport itself rejects retirement after a successful body read", async () => {
    const body = deferred<any>(); fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
    const request = api.composeAgent("synthetic-a", "company-a", "Synthetic description");
    await settle(); newOwner("login"); body.resolve(composed);
    await expect(request).rejects.toBeInstanceOf(SessionChangedError);
  });
});

describe("actual queued company action updaters", () => {
  const retained = () => JSON.parse(JSON.stringify(h.retainedPage()));
  async function loadNewOwner(kind: "model" | "autonomy" | "compose") {
    h.deferWrites = false; newOwner("login");
    const load = deferred<Response>(); companyReads.push(load); h.render();
    load.resolve(response({ ...company(), name: "CURRENT_COMPANY_NEW_LOGIN" })); await settle(); h.render();
    if (kind === "model") h.modelAction("NEW_MODEL_DRAFT_CURRENT");
    else if (kind === "compose") h.openComposer("NEW_COMPOSER_DRAFT_CURRENT");
  }
  it.each(["model", "autonomy", "compose"] as const)("%s queued initiation/optimism cannot change retained state after owner retirement", async kind => {
    await mount(); const submit = action(kind), gate = deferred<Response>(); mutations.push(gate);
    h.deferWrites = true; const run = submit(); expect(h.queuedWrites.length).toBeGreaterThan(0);
    await loadNewOwner(kind); const before = retained(); h.flushWrites();
    expect(retained()).toEqual(before); h.render(false); expect(h.text()).toContain("CURRENT_COMPANY_NEW_LOGIN");
    gate.resolve(response(kind === "compose" ? composed : {})); await run;
    expect(retained()).toEqual(before); expect(h.retainedToasts()).toEqual([]);
  });
  it.each(["model", "compose"] as const)("%s queued success/company/draft cleanup/finally cannot overwrite a new login", async kind => {
    await mount(); const submit = action(kind);
    const refresh = deferred<Response>(); companyReads.push(refresh);
    h.deferWrites = true; const run = submit(); await settle();
    refresh.resolve(response({ ...company(), name: "PRIVATE_QUEUED_COMPANY_A" })); await run;
    expect(h.queuedWrites.length).toBeGreaterThan(3);
    await loadNewOwner(kind); const before = retained(); h.flushWrites(); expect(retained()).toEqual(before);
    h.render(false); expect(h.text()).toContain("CURRENT_COMPANY_NEW_LOGIN"); expect(h.text()).not.toContain("PRIVATE_QUEUED_COMPANY_A");
    expect(h.text()).toContain(kind === "model" ? "NEW_MODEL_DRAFT_CURRENT" : "NEW_COMPOSER_DRAFT_CURRENT");
    expect(h.retainedToasts()).toEqual([]);
  });
  it.each(["model", "autonomy", "compose"] as const)("%s queued catch/error/rollback/finally cannot overwrite a new login", async kind => {
    await mount(); const submit = action(kind), gate = deferred<Response>(); mutations.push(gate);
    h.deferWrites = true; const run = submit(); gate.resolve(response({ message: "PRIVATE_QUEUED_ERROR_A" }, 400)); await run;
    expect(h.queuedWrites.length).toBeGreaterThan(2);
    await loadNewOwner(kind); const before = retained(); h.flushWrites(); expect(retained()).toEqual(before);
    expect(JSON.stringify(h.retainedPage())).not.toContain("PRIVATE_QUEUED_ERROR_A"); expect(h.retainedToasts()).toEqual([]);
    h.render(false); expect(feedbackBusy(kind)).toBe(false);
  });
  it.each(["model", "autonomy", "compose"] as const)("%s old finally updater keeps a newer same-owner request busy", async kind => {
    await mount(); const submit = action(kind); h.deferWrites = true; await submit();
    expect(h.queuedWrites.length).toBeGreaterThan(1);
    h.deferWrites = false; const next = deferred<Response>(); mutations.push(next); const run = submit(); h.render();
    expect(feedbackBusy(kind)).toBe(true); expect(mutationCount()).toBe(2);
    h.flushWrites(); h.render();
    // A completed model save closes its editor. Reopen the actual editor to
    // observe the newer request's disabled input, without reading hook indices.
    if (kind === "model" && !h.maybe((node: any) => node.type === "input" && node.props.list)) {
      h.button("app.companyDetail.editLabel").props.onClick({ stopPropagation() {} }); h.render();
    }
    expect(feedbackBusy(kind)).toBe(true);
    await submit(); expect(mutationCount()).toBe(2);
    next.resolve(response(kind === "compose" ? composed : {})); await run; h.render();
    expect(feedbackBusy(kind)).toBe(false);
  });
});
