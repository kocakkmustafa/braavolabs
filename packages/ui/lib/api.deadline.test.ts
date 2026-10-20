import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  state: { revision: 1, tenantId: "fixture-tenant", token: "old", refreshToken: "refresh-old" },
  fetch: vi.fn(),
}));
vi.mock("./store", () => ({
  captureAuthSession: () => ({ ...fixture.state }),
  isAuthSessionCurrent: (owner: typeof fixture.state) => owner.revision === fixture.state.revision && owner.tenantId === fixture.state.tenantId,
  refreshAuthSession: (owner: typeof fixture.state, token: string, tenantId: string, refreshToken: string) => {
    if (owner.revision !== fixture.state.revision || tenantId !== fixture.state.tenantId) return false;
    fixture.state.token = token; fixture.state.refreshToken = refreshToken; return true;
  },
  useAppStore: { getState: () => ({ clearAuth: vi.fn() }) },
}));
import { apiFetch } from "./api";
const response = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body });
const never = () => new Promise<never>(() => {});
beforeEach(() => {
  vi.useFakeTimers(); fixture.fetch.mockReset();
  Object.assign(fixture.state, { revision: 1, tenantId: "fixture-tenant", token: "old", refreshToken: "refresh-old" });
  vi.stubGlobal("fetch", fixture.fetch);
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual web API total deadline", () => {
  it.each([200, 503])("bounds a fast-header, never-ending %s JSON body and aborts the transport", async status => {
    fixture.fetch.mockResolvedValue({ ...response(status, {}), json: never });
    const pending = apiFetch("/fixture", { token: "old", timeoutMs: 20 });
    const expected = expect(pending).rejects.toMatchObject({ name: "RequestTimeoutError", code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20); await expected;
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not send a pre-cancelled request", async () => {
    const controller = new AbortController(); controller.abort(new Error("owner cancelled"));
    await expect(apiFetch("/fixture", { signal: controller.signal })).rejects.toThrow("owner cancelled");
    expect(fixture.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps caller cancellation active through body consumption", async () => {
    const controller = new AbortController(); fixture.fetch.mockResolvedValue({ ...response(200, {}), json: never });
    const pending = apiFetch("/fixture", { signal: controller.signal, timeoutMs: 100 });
    const expected = expect(pending).rejects.toThrow("owner cancelled");
    await vi.advanceTimersByTimeAsync(1); controller.abort(new Error("owner cancelled")); await expected;
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("a timed-out caller leaves the shared refresh alive for its other waiter", async () => {
    let release!: (response: unknown) => void;
    const refreshed = new Promise(resolve => { release = resolve; });
    fixture.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith("/auth/refresh")
      ? refreshed : Promise.resolve(response(new Headers(init.headers).get("Authorization") === "Bearer old" ? 401 : 200, { value: "ok" })));
    const first = apiFetch("/fixture", { token: "old", timeoutMs: 10 });
    const firstExpected = expect(first).rejects.toMatchObject({ name: "RequestTimeoutError" });
    const second = apiFetch("/fixture", { token: "old", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10); await firstExpected;
    const refresh = fixture.fetch.mock.calls.find(([url]) => url.endsWith("/auth/refresh"))!;
    expect(refresh[1].signal.aborted).toBe(false);
    release(response(200, { token: "new", refreshToken: "refresh-new", tenant: { id: "fixture-tenant" } }));
    await expect(second).resolves.toEqual({ value: "ok" });
    expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a slow refresh does not reset the original request's total budget", async () => {
    fixture.fetch.mockImplementation((url: string) => url.endsWith("/auth/refresh")
      ? never() : Promise.resolve(response(401, {})));
    const pending = apiFetch("/fixture", { token: "old", timeoutMs: 20 });
    const expected = expect(pending).rejects.toMatchObject({ name: "RequestTimeoutError" });
    await vi.advanceTimersByTimeAsync(20); await expected;
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    // Shared refresh has its own finite budget; it cannot live forever.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up the deadline on a successful body without aborting it later", async () => {
    fixture.fetch.mockResolvedValue(response(200, { value: "ok" }));
    await expect(apiFetch("/fixture", { timeoutMs: 20 })).resolves.toEqual({ value: "ok" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
