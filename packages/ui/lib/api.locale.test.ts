import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "../i18n/locales";
const fixture = vi.hoisted(() => ({
  state: { revision: 1, tenantId: "fixture-tenant", token: "old", refreshToken: "refresh-old" }, fetch: vi.fn(),
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
const response = (status = 200, body: unknown = { value: "fixture" }) => ({ status, ok: status < 300, json: async () => body });
const requestHeaders = (call = 0) => new Headers(fixture.fetch.mock.calls[call][1].headers);
beforeEach(() => {
  fixture.fetch.mockReset().mockResolvedValue(response());
  Object.assign(fixture.state, { revision: 1, tenantId: "fixture-tenant", token: "old", refreshToken: "refresh-old" });
  vi.stubGlobal("fetch", fixture.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("actual web API language header, with a synthetic fetch boundary", () => {
  it.each(locales)("sends the saved %s app preference without consulting an OS language", async locale => {
    vi.stubGlobal("document", { cookie: `other=synthetic; NEXT_LOCALE=${locale}` });
    vi.stubGlobal("navigator", { get language() { throw Error("OS preference must not override the app"); } });
    await expect(apiFetch("/fixture", { token: "old", method: "POST", body: '{"synthetic":true}' })).resolves.toEqual({ value: "fixture" });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(requestHeaders().get("Accept-Language")).toBe(locale);
    expect(requestHeaders().get("Authorization")).toBe("Bearer old");
    expect(requestHeaders().get("Content-Type")).toBe("application/json");
    expect(requestHeaders().get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(fixture.fetch.mock.calls[0][1]).toMatchObject({ body: '{"synthetic":true}', credentials: "include", method: "POST" });
  });
  it.each([["es", "es-419"], ["pt_br", "pt-BR"], ["zh-CN", "zh-Hans"], ["zh-Hant", "en"], ["ja%0d%0aInjected=x", "en"], ["%zz", "en"]])("normalizes the cookie %s to one canonical header", async (cookie, expected) => {
    vi.stubGlobal("document", { cookie: `NEXT_LOCALE=${cookie}` });
    await apiFetch("/fixture"); expect(requestHeaders().get("Accept-Language")).toBe(expected);
  });
  it.each([undefined, { cookie: "" }, { get cookie() { throw Error("storage blocked"); } }])("has an SSR/blocked-cookie English fallback", async documentFixture => {
    vi.stubGlobal("document", documentFixture); await apiFetch("/fixture");
    expect(requestHeaders().get("Accept-Language")).toBe("en");
  });
  it.each([new Headers({ "accept-language": "de", Accept: "text/markdown" }), [["accept-language", "de"], ["Accept", "text/markdown"]], { "aCcEpT-LaNgUaGe": "de", Accept: "text/markdown" }])("normalizes all native header forms without allowing a second language value", async headers => {
    vi.stubGlobal("document", { cookie: "NEXT_LOCALE=ja" });
    await apiFetch("/fixture", { headers: headers as HeadersInit });
    expect(requestHeaders().get("Accept-Language")).toBe("ja"); expect(requestHeaders().get("Accept")).toBe("text/markdown");
  });
  it("keeps a logical request's original locale across its one authentication replay", async () => {
    const documentFixture = { cookie: "NEXT_LOCALE=ja" }; vi.stubGlobal("document", documentFixture);
    let first = true;
    fixture.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return response(200, { token: "new", refreshToken: "refresh-new", tenant: { id: "fixture-tenant" } });
      if (first) { first = false; documentFixture.cookie = "NEXT_LOCALE=fr"; return response(401); }
      return response();
    });
    await apiFetch("/fixture", { token: "old" });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(requestHeaders(0).get("Accept-Language")).toBe("ja");
    expect(requestHeaders(1).get("Accept-Language")).toBe("fr");
    expect(requestHeaders(2).get("Accept-Language")).toBe("ja");
    expect(requestHeaders(2).get("Authorization")).toBe("Bearer new");
  });
});
