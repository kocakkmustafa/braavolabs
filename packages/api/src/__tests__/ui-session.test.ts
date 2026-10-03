import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (status: number, data: unknown = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const refreshedA = { token: "A-fresh", refreshToken: "A-refresh-fresh", tenant: { id: "tenant-A" } };

async function harness() {
  vi.resetModules();
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  vi.stubGlobal("localStorage", localStorage);
  const location = { pathname: "/dashboard", href: "/dashboard" };
  vi.stubGlobal("window", { location, localStorage });
  const { useAppStore } = await import("../../../ui/lib/store");
  const client = await import("../../../ui/lib/api");
  useAppStore.getState().setAuth("A-token", "tenant-A", "A-refresh");
  return { useAppStore, client, location, storage };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("web API session ownership", () => {
  it("does not restore A after a refresh finishes following logout", async () => {
    const h = await harness();
    const refresh = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(401)).mockReturnValueOnce(refresh.promise).mockResolvedValue(json(200));
    vi.stubGlobal("fetch", fetch);
    const request = h.client.apiFetch("/companies", { token: "A-token" }).catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    h.useAppStore.getState().clearAuth();
    refresh.resolve(json(200, refreshedA));
    await request;
    expect(h.useAppStore.getState().token).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([200, 401])("leaves B intact when A's in-flight refresh returns HTTP %s", async (status) => {
    const h = await harness();
    const refresh = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(401)).mockReturnValueOnce(refresh.promise).mockResolvedValue(json(200));
    vi.stubGlobal("fetch", fetch);
    const request = h.client.apiFetch("/companies", { token: "A-token" }).catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    h.useAppStore.getState().clearAuth();
    h.useAppStore.getState().setAuth("B-token", "tenant-B", "B-refresh");
    refresh.resolve(json(status, refreshedA));
    await request;
    expect(h.useAppStore.getState()).toMatchObject({ token: "B-token", tenantId: "tenant-B", refreshToken: "B-refresh" });
    expect(h.location.href).toBe("/dashboard");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh or replay A's DELETE after B has signed in", async () => {
    const h = await harness();
    const first = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(json(200, {
      token: "B-fresh", refreshToken: "B-refresh-fresh", tenant: { id: "tenant-B" },
    })).mockResolvedValue(json(200));
    vi.stubGlobal("fetch", fetch);
    const request = h.client.apiFetch("/users/me", { method: "DELETE", token: "A-token" }).catch((error) => error);
    h.useAppStore.getState().clearAuth();
    h.useAppStore.getState().setAuth("B-token", "tenant-B", "B-refresh");
    first.resolve(json(401));
    const error = await request;
    expect(error).toMatchObject({ name: "SessionChangedError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.useAppStore.getState().token).toBe("B-token");
  });

  it("shares one refresh for two 401s in the same session", async () => {
    const h = await harness();
    const refresh = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(401)).mockResolvedValueOnce(json(401))
      .mockReturnValueOnce(refresh.promise).mockImplementation(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const first = h.client.apiFetch("/companies", { token: "A-token" });
    const second = h.client.apiFetch("/dashboard", { token: "A-token" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    refresh.resolve(json(200, refreshedA));
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(1);
    expect(h.useAppStore.getState().token).toBe("A-fresh");
  });

  it("preserves session state on a transient refresh 503", async () => {
    const h = await harness();
    const fetch = vi.fn().mockResolvedValueOnce(json(401)).mockResolvedValueOnce(json(503));
    vi.stubGlobal("fetch", fetch);
    const error = await h.client.apiFetch("/companies", { token: "A-token" }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 503 });
    expect(h.useAppStore.getState().token).toBe("A-token");
    expect(h.location.href).toBe("/dashboard");
  });

  it("reuses the rotated access token for a 401 arriving after the first refresh completed", async () => {
    const h = await harness();
    const late = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(401)).mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(json(200, refreshedA))
      .mockImplementation(async (url) => String(url).endsWith("/auth/refresh") ? json(401) : json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const first = h.client.apiFetch("/companies", { token: "A-token" });
    const second = h.client.apiFetch("/dashboard", { token: "A-token" }).catch((error) => error);
    await expect(first).resolves.toEqual({ ok: true });
    late.resolve(json(401));
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(1);
    expect(h.useAppStore.getState().token).toBe("A-fresh");
  });

  it("does not erase B when an older sign-out finishes", async () => {
    const h = await harness();
    const logout = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(logout.promise));
    const signingOut = h.client.api.signOut();
    h.useAppStore.getState().setAuth("B-token", "tenant-B", "B-refresh");
    logout.resolve(json(200));
    await signingOut;
    expect(h.useAppStore.getState().token).toBe("B-token");
  });

  it("rejects A's response when B signs in while JSON is still being read", async () => {
    const h = await harness();
    const body = deferred<unknown>();
    const read = vi.fn().mockReturnValue(body.promise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: read }));
    const request = h.client.apiFetch("/users/me", { token: "A-token" }).catch((error) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    h.useAppStore.getState().setAuth("B-token", "tenant-B", "B-refresh");
    body.resolve({ private: "A-private-result" });
    expect(await request).toMatchObject({ name: "SessionChangedError" });
  });
});


describe("onboarding drafts follow authentication boundaries", () => {
  it.each(["tenant-A", "tenant-B"])("clears A's private draft when another user signs in to %s", async (tenantId) => {
    const h = await harness();
    h.storage.set("aicos-onboarding-draft", JSON.stringify({ description: "PRIVATE_A" }));
    h.useAppStore.getState().setAuth("B-token", tenantId, "B-refresh");
    expect(h.storage.has("aicos-onboarding-draft")).toBe(false);
  });
  it("clears draft on logout while same-session refresh preserves it", async () => {
    const h = await harness();
    h.storage.set("aicos-onboarding-draft", JSON.stringify({ description: "PRIVATE_A" }));
    const { captureAuthSession, refreshAuthSession } = await import("../../../ui/lib/store");
    expect(refreshAuthSession(captureAuthSession(), "A-new", "tenant-A", "A-refresh-new")).toBe(true);
    expect(h.storage.has("aicos-onboarding-draft")).toBe(true);
    h.useAppStore.getState().clearAuth();
    expect(h.storage.has("aicos-onboarding-draft")).toBe(false);
  });
});


it("discards an ownerless legacy hero at every authentication boundary", async () => {
  const h = await harness();
  const hero = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { removeItem: (key: string) => hero.delete(key) });
  h.useAppStore.getState().clearAuth();
  hero.set("aicos-build-desc", "NEW_GUEST_INTENT");
  h.useAppStore.getState().setAuth("new-user-token", "tenant-C");
  expect(hero.has("aicos-build-desc")).toBe(false);
  h.useAppStore.getState().setAuth("other-user-token", "tenant-C");
  expect(hero.has("aicos-build-desc")).toBe(false);
  hero.set("aicos-build-desc", "PRIVATE_AUTHENTICATED_INTENT");
  h.useAppStore.getState().clearAuth();
  expect(hero.has("aicos-build-desc")).toBe(false);
});


it("still clears accessible hero storage when local storage cleanup throws", async () => {
  const h = await harness();
  const removeHero = vi.fn();
  vi.stubGlobal("sessionStorage", { removeItem: removeHero });
  vi.stubGlobal("localStorage", { removeItem: () => { throw new Error("unavailable"); } });
  h.useAppStore.getState().clearAuth();
  expect(removeHero).toHaveBeenCalledWith("aicos-build-desc");
  expect(h.useAppStore.getState().token).toBeNull();
});
