/**
 * SEC-BRA-02 / B7 + B8 — MCP client outbound hardening.
 *
 * The connector credentials may only ever reach the connector's own registered
 * origin, over a socket pinned to a validated address. DNS rebinding, redirects
 * to metadata/internal hosts and cross-origin redirects must fail before a
 * second socket opens, and upstream bodies must never reflect the credential.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: https.request }));
const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: http.request }));
vi.mock("../logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { callTool, listTools } from "../mcp";
import { AppError } from "../../middleware/error";

afterEach(() => {
  dns.lookup.mockReset();
  https.request.mockReset();
  http.request.mockReset();
});

interface Resp { status: number; headers?: Record<string, string>; body?: string }
interface Obs { options: Record<string, any>; body: unknown }

function mockHttps(responses: Resp[]): Obs[] {
  const seen: Obs[] = [];
  const queue = [...responses];
  https.request.mockImplementation((options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: (b?: unknown) => void };
    request.end = (body?: unknown) => {
      seen.push({ options, body });
      const r = queue.shift();
      if (!r) throw new Error("no response configured");
      const message = new EventEmitter() as EventEmitter & Record<string, any>;
      message.rawHeaders = Object.entries(r.headers ?? {}).flatMap(([k, v]) => [k, v]);
      message.statusCode = r.status;
      message.statusMessage = "TEST";
      message.destroy = vi.fn();
      callback(message);
      queueMicrotask(() => {
        if (r.body !== undefined) message.emit("data", Buffer.from(r.body));
        message.emit("end");
      });
    };
    return request;
  });
  return seen;
}

const creds = { apiKey: "sk-SECRET-connector-key" };

async function expectRejected(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as Error).message).toMatch(/^Connector URL rejected/);
  expect((err as Error).message).not.toContain("SECRET");
  return err as Error;
}

describe("mcp client — SSRF (B7)", () => {
  it("rejects literal private / metadata / loopback / IPv6 / encoded targets before any socket", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://10.1.2.3/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://[fd00:ec2::254]/mcp",
      "https://[::ffff:a9fe:a9fe]/mcp",
      "https://2130706433/mcp", // decimal-encoded 127.0.0.1, normalised by URL
      "https://0x7f.1/mcp", // hex/short form
      "file:///etc/passwd",
      "https://user:pw@example.com/mcp",
    ]) {
      await expectRejected(listTools(url, "API_KEY", creds));
    }
    expect(https.request).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname resolving to metadata, or a mixed public+private DNS answer (rebinding)", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expectRejected(callTool("https://metadata.google.internal/mcp", "API_KEY", creds, "t", {}));
    dns.lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "fe80::1", family: 6 },
    ]);
    await expectRejected(callTool("https://rebind.example/mcp", "API_KEY", creds, "t", {}));
    expect(https.request).not.toHaveBeenCalled();
  });

  it("pins the socket to the validated address and keeps the connector Host", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const seen = mockHttps([{ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "x", result: { tools: [] } }) }]);
    await expect(listTools("https://mcp.example/rpc", "API_KEY", creds)).resolves.toEqual([]);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    const o = seen[0]!.options;
    expect(o.headers.host).toBe("mcp.example");
    const pinned: unknown[] = [];
    o.lookup("anything-else.example", {}, (_e: unknown, a: string) => pinned.push(a));
    expect(pinned).toEqual(["93.184.216.34"]);
  });

  it("re-resolves a redirect hop and refuses it when DNS now points at metadata", async () => {
    dns.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const seen = mockHttps([{ status: 307, headers: { location: "https://mcp.example/next" } }]);
    await expectRejected(listTools("https://mcp.example/rpc", "API_KEY", creds));
    expect(seen).toHaveLength(1);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });
});

describe("mcp client — audience / token reflection (B8)", () => {
  it("never follows a redirect to another origin with the credential", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const seen = mockHttps([
      { status: 307, headers: { location: "https://attacker.example/collect" } },
      { status: 200, body: "{}" },
    ]);
    const err = await expectRejected(callTool("https://mcp.example/rpc", "API_KEY", creds, "t", {}));
    expect(err.message).toMatch(/Cross-origin/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.headers.host).toBe("mcp.example");
  });

  it("refuses a 302 that would convert the credentialed POST into a GET", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const seen = mockHttps([
      { status: 302, headers: { location: "https://mcp.example/elsewhere" } },
      { status: 200, body: "{}" },
    ]);
    const err = await expectRejected(callTool("https://mcp.example/rpc", "API_KEY", creds, "t", {}));
    expect(err.message).toMatch(/method conversion/);
    expect(seen).toHaveLength(1);
  });

  it("sends the credential only to the registered URL; args never choose the target", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const seen = mockHttps([{ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "x", result: {} }) }]);
    await callTool("https://mcp.example/rpc", "API_KEY", creds, "t", { url: "https://evil.example" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.headers.authorization).toBe("Bearer sk-SECRET-connector-key");
    expect(seen[0]!.options.hostname).toBe("mcp.example");
    expect(String(seen[0]!.body)).toContain("evil.example");
  });

  it("does not reflect an upstream error body that echoes the token", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockHttps([{ status: 401, body: "bad token sk-SECRET-connector-key" }]);
    const err = await callTool("https://mcp.example/rpc", "API_KEY", creds, "t", {}).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as Error).message).toBe("MCP server returned 401");
  });
});

describe("mcp client — SEC-BRA-02b transport safety", () => {
  it("refuses cleartext http when credentials would be sent, before DNS or socket", async () => {
    await expectRejected(listTools("http://mcp.example/rpc", "API_KEY", creds));
    await expectRejected(callTool("http://mcp.example/rpc", "BASIC", { username: "u", password: "p" }, "t", {}));
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it("refuses an https -> http redirect hop when credentials are attached", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const seen = mockHttps([{ status: 307, headers: { location: "http://mcp.example/next" } }]);
    await expectRejected(listTools("https://mcp.example/rpc", "API_KEY", creds));
    expect(seen).toHaveLength(1);
  });

  it("still lets a credential-less http connector pass URL validation (reaches the socket layer)", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    http.request.mockImplementation(() => {
      throw new Error("socket-reached");
    });
    const err = await listTools("http://mcp.example/rpc", "NONE", undefined).then(() => null, (e) => e);
    expect(http.request).toHaveBeenCalled();
    expect(String(err?.message ?? "")).not.toMatch(/HTTPS is required/);
  });

  it("maps an over-limit upstream body to 502, not 400", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockHttps([{ status: 200, body: "x".repeat(16 * 1024 * 1024 + 1) }]);
    const err = await listTools("https://mcp.example/rpc", "API_KEY", creds).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(502);
    expect((err as Error).message).not.toContain("SECRET");
  });
});
