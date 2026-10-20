import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({revision: 1, tenantId: "synthetic-tenant" as string | null, token: "synthetic-token" as string | null}));
vi.mock("./store", () => ({
  captureAuthSession: () => ({...state}), isAuthSessionCurrent: (owner: typeof state) => owner.revision === state.revision && owner.tenantId === state.tenantId,
  useAppStore: {getState: () => ({...state})},
}));
import { api } from "./api";
import { parseCompareOptions } from "./compare";
const fetchSpy = vi.fn();
const options = {companyId: "company/a?b", maxCandidates: 3, selections: [
  {provider: "OPENAI", model: "gpt-4o", reasoningEfforts: []}, {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"]},
]};
const response = (body: unknown, status = 200) => ({ok: status < 400, status, json: async () => body});
beforeEach(() => { state.revision = 1; state.tenantId = "synthetic-tenant"; state.token = "synthetic-token"; fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());
describe("actual compare API transport", () => {
  it("discovers options for the encoded company with the supplied cancellation signal", async () => {
    const controller = new AbortController(); fetchSpy.mockResolvedValue(response(options));
    await expect(api.compareOptions("synthetic-token", "company/a?b", controller.signal)).resolves.toEqual(options);
    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toContain("/research/compare/options?companyId=company%2Fa%3Fb"); expect(request.signal).toBeInstanceOf(AbortSignal); expect(request.signal.aborted).toBe(false);
    expect(request.headers.Authorization).toBe("Bearer synthetic-token"); expect(request.credentials).toBe("include");
  });
  it("POSTs once to the selected endpoint, preserving ordered pairs, explicit effort and omission", async () => {
    fetchSpy.mockResolvedValue(response({id: "session", status: "PENDING"}, 201)); const controller = new AbortController();
    const selections = [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" as const}, {provider: "OPENAI", model: "gpt-4o"}];
    await api.startSelectedCompare("synthetic-token", {companyId: "company-a", query: "Synthetic question", selections}, controller.signal);
    expect(fetchSpy).toHaveBeenCalledOnce(); const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toContain("/research/compare/selected"); expect(request.method).toBe("POST"); expect(request.signal).toBeInstanceOf(AbortSignal); expect(request.signal.aborted).toBe(false);
    expect(JSON.parse(request.body)).toEqual({companyId: "company-a", query: "Synthetic question", selections});
    expect(JSON.parse(request.body).selections[1]).not.toHaveProperty("reasoningEffort");
  });
  it.each([400, 404, 500])("fails closed on old/invalid server HTTP %s without another route or POST", async status => {
    fetchSpy.mockResolvedValue(response({error: "synthetic rejection"}, status));
    await expect(api.startSelectedCompare("synthetic-token", {companyId: "company-a", query: "Synthetic question", selections: [{provider: "OPENAI", model: "gpt-4o"}]})).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it.each(["options", "start"])("propagates caller cancellation through the bounded %s request without replay", async action => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = action === "options"
      ? api.compareOptions("synthetic-token", "company/a?b", controller.signal)
      : api.startSelectedCompare("synthetic-token", {companyId: "company-a", query: "Synthetic question", selections: [{provider: "OPENAI", model: "gpt-4o"}]}, controller.signal);
    const failure = expect(pending).rejects.toMatchObject({name: "AbortError"});
    const request = fetchSpy.mock.calls[0][1];
    expect(request.signal.aborted).toBe(false);
    controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    await failure;
    expect(request.signal.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it("rejects a response that arrives after tenant retirement", async () => {
    let finish!: (value: any) => void; fetchSpy.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const request = api.compareOptions("synthetic-token", "company/a?b"); state.revision++; state.tenantId = "other-tenant"; state.token = "other-token";
    finish(response(options)); await expect(request).rejects.toMatchObject({name: "SessionChangedError"}); expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it("rejects a stale token before making a request", async () => {
    state.token = "new-token"; await expect(api.compareOptions("old-token", "company/a?b")).rejects.toMatchObject({name: "SessionChangedError"});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("requires the requested session and company before publishing a poll response", async () => {
    fetchSpy.mockResolvedValue(response({id: "session", companyId: "foreign-company", status: "RUNNING"}));
    await expect(api.compareSession("synthetic-token", "session", "company-a")).rejects.toThrow("Invalid compare session");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it.each([{id: "", status: "PENDING"}, {id: "session", status: "COMPLETED"}, {}])("rejects malformed successful start %j without repeating it", async body => {
    fetchSpy.mockResolvedValue(response(body, 201));
    await expect(api.startSelectedCompare("synthetic-token", {companyId: "company-a", query: "Synthetic question", selections: [{provider: "OPENAI", model: "gpt-4o"}]})).rejects.toThrow("Invalid compare start");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("secret-free discovery parser", () => {
  it.each([
    {}, {...options, companyId: "foreign"}, {...options, maxCandidates: 4}, {...options, apiKey: "synthetic-leak"},
    {...options, selections: [{provider: "OPENAI", model: "gpt-4o"}]},
    {...options, selections: [{provider: "OPENAI", model: "gpt-4o", reasoningEfforts: ["none"]}]},
    {...options, selections: [{provider: "OPENAI", model: "gpt-4o", reasoningEfforts: ["high", "high"]}]},
    {...options, selections: [{...options.selections[0], baseUrl: "https://proxy.example.invalid"}]},
    {...options, selections: [options.selections[0], options.selections[0]]},
  ])("rejects malformed/ambiguous metadata %j", value => {
    expect(() => parseCompareOptions(value, options.companyId)).toThrow();
  });
});
