/**
 * External control adapters — HTTP contract (mocked fetch, no real platform).
 *
 * The capability-matrix test pins the flags; this pins the actual request each
 * control method makes — the URL it builds, the auth header it sends, and how
 * it parses the response. Catches the bugs most likely to bite in the field
 * (wrong n8n activate path, bad Make scenario URL parse, missing webhook auth).
 * The SSRF resolver is stubbed so we don't do real DNS for example.com hosts;
 * the URL/regex guard still runs (loopback is still refused — covered below).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../lib/ssrf", () => ({ assertSafeExternalUrl: async () => {} }));

import { n8nAdapter } from "../adapters/n8n";
import { makeAdapter } from "../adapters/make";
import { genericAdapter } from "../adapters/generic";

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function stubFetch(impl: (...a: any[]) => any) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

const cfg = (baseUrl: string) => ({ baseUrl, apiKey: "KEY", cursor: null });

describe("n8n control HTTP", () => {
  it("discoverWorkflows GETs /api/v1/workflows with the api-key header and maps active", async () => {
    const f = stubFetch(async () => okJson({ data: [{ id: 7, name: "Lead sync", active: true }] }));
    const list = await n8nAdapter.discoverWorkflows!(cfg("https://n8n.example.com"));
    expect(list).toEqual([{ id: "7", name: "Lead sync", active: true }]);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("/api/v1/workflows");
    expect((init.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe("KEY");
  });

  it("setActive POSTs activate / deactivate for the workflow id", async () => {
    const f = stubFetch(async () => okJson({}));
    await n8nAdapter.setActive!(cfg("https://n8n.example.com"), "7", true);
    expect(String(f.mock.calls[0][0])).toContain("/api/v1/workflows/7/activate");
    expect(f.mock.calls[0][1].method).toBe("POST");
    await n8nAdapter.setActive!(cfg("https://n8n.example.com"), "7", false);
    expect(String(f.mock.calls[1][0])).toContain("/api/v1/workflows/7/deactivate");
  });
});

describe("make control HTTP", () => {
  const base = "https://eu1.make.com/api/v2/scenarios/123/logs";

  it("triggerWorkflow POSTs /scenarios/<id>/run with Token auth on the same zone", async () => {
    const f = stubFetch(async () => okJson({}));
    await makeAdapter.triggerWorkflow!(cfg(base), "123");
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://eu1.make.com/api/v2/scenarios/123/run");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token KEY");
  });

  it("setActive POSTs start / stop", async () => {
    const f = stubFetch(async () => okJson({}));
    await makeAdapter.setActive!(cfg(base), "123", true);
    expect(String(f.mock.calls[0][0])).toBe("https://eu1.make.com/api/v2/scenarios/123/start");
    await makeAdapter.setActive!(cfg(base), "123", false);
    expect(String(f.mock.calls[1][0])).toBe("https://eu1.make.com/api/v2/scenarios/123/stop");
  });

  it("discoverWorkflows surfaces the single scenario with its name + active state", async () => {
    stubFetch(async () => okJson({ scenario: { name: "Nightly", isActive: true } }));
    const list = await makeAdapter.discoverWorkflows!(cfg(base));
    expect(list).toEqual([{ id: "123", name: "Nightly", active: true }]);
  });
});

describe("generic / zapier control HTTP", () => {
  it("triggerWorkflow POSTs the webhook URL with bearer + api-key + a json body", async () => {
    const f = stubFetch(async () => okJson({}));
    await genericAdapter.triggerWorkflow!(cfg("https://x.example.com/feed"), "https://hooks.zapier.com/abc");
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://hooks.zapier.com/abc");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("KEY");
    expect(typeof init.body).toBe("string");
  });

  it("triggerWorkflow refuses a loopback webhook (SSRF guard, no network)", async () => {
    stubFetch(async () => okJson({}));
    await expect(
      genericAdapter.triggerWorkflow!(cfg("https://x.example.com/feed"), "http://127.0.0.1/hook"),
    ).rejects.toThrow();
  });
});
