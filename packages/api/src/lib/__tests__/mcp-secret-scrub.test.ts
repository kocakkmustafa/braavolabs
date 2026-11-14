/** SEC-BRA-06b: the MCP client must not log or throw upstream text containing the credential. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "sk-LIVE-connector-secret-123";
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../logger", () => ({ logger: logs }));
vi.mock("../ssrf", () => ({ safeExternalFetch: fetchMock, SsrfError: class extends Error {} }));

import { callTool, listTools } from "../mcp";

beforeEach(() => {
  for (const m of [...Object.values(logs), fetchMock]) (m as any).mockReset();
});

describe("mcp client secret scrubbing", () => {
  it("HTTP error body is scrubbed before logger.warn", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid key " + SECRET });
    await expect(callTool("https://m.example/rpc", "API_KEY", { apiKey: SECRET }, "t", {})).rejects.toThrow("MCP server returned 401");
    expect(logs.warn).toHaveBeenCalled();
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(SECRET);
  });

  it("JSON-RPC error message is scrubbed in the thrown AppError", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "Bearer " + SECRET + " rejected" } }),
    });
    const err: any = await callTool("https://m.example/rpc", "API_KEY", { apiKey: SECRET }, "t", {}).catch((e) => e);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("[REDACTED]");
  });

  it("secret straddling the 300-char log cut is scrubbed before truncation", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "p".repeat(290) + SECRET });
    await callTool("https://m.example/rpc", "API_KEY", { apiKey: SECRET }, "t", {}).catch(() => undefined);
    const logged = JSON.stringify(logs.warn.mock.calls);
    expect(logged).not.toContain(SECRET.slice(0, 6));
  });

  it("invalid JSON body yields a fixed AppError without upstream text", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token " + SECRET); } });
    const err: any = await callTool("https://m.example/rpc", "API_KEY", { apiKey: SECRET }, "t", {}).catch((e) => e);
    expect(err.message).toBe("MCP yanıtı geçersiz JSON");
  });

  it("listTools result (descriptions) is scrubbed", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "1", result: { tools: [{ name: "a", description: "use key " + SECRET, inputSchema: {} }] } }) });
    const tools = await listTools("https://m.example/rpc", "API_KEY", { apiKey: SECRET });
    expect(JSON.stringify(tools)).not.toContain(SECRET);
  });
});
