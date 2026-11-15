/** BRA-P1-02a-2 — tokenUrl must share the connector's registered domain. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/db", () => ({ prisma: {} }));
vi.mock("../../../lib/encryption", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("../../../lib/ssrf", () => ({ safeExternalFetch: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { isTokenUrlSameSite as ok } from "../oauth-refresh";

const M = "https://mcp.example.com/rpc";

describe("isTokenUrlSameSite", () => {
  it("identical host", () => expect(ok("https://mcp.example.com/token", M)).toBe(true));
  it("subdomain of connector registered domain", () => expect(ok("https://auth.example.com/token", M)).toBe(true));
  it("apex when connector is a subdomain", () => expect(ok("https://example.com/token", M)).toBe(true));
  it("deeper subdomain", () => expect(ok("https://a.b.example.com/t", "https://example.com/x")).toBe(true));
  it("different domain is refused", () => expect(ok("https://evil.com/token", M)).toBe(false));
  it("example.com.evil.com is refused", () => expect(ok("https://example.com.evil.com/t", M)).toBe(false));
  it("notexample.com is refused", () => expect(ok("https://notexample.com/t", M)).toBe(false));
  it("case-insensitive", () => expect(ok("https://AUTH.Example.COM/t", "https://MCP.EXAMPLE.com/x")).toBe(true));
  it("trailing dot ignored", () => expect(ok("https://auth.example.com./t", M)).toBe(true));
  it("port and path ignored", () => expect(ok("https://auth.example.com:8443/a/b?x=1", "https://mcp.example.com:9000/z")).toBe(true));
  it("IPv4 equal passes, different fails", () => {
    expect(ok("https://10.0.0.5/t", "https://10.0.0.5:8443/rpc")).toBe(true);
    expect(ok("https://10.0.0.6/t", "https://10.0.0.5/rpc")).toBe(false);
  });
  it("IPv6 equal passes, different fails", () => {
    expect(ok("https://[::1]/t", "https://[::1]:9/rpc")).toBe(true);
    expect(ok("https://[::2]/t", "https://[::1]/rpc")).toBe(false);
  });
  it("co.uk: sibling registered domains differ, same one passes", () => {
    expect(ok("https://a.co.uk/t", "https://b.co.uk/rpc")).toBe(false);
    expect(ok("https://auth.acme.co.uk/t", "https://mcp.acme.co.uk/rpc")).toBe(true);
    expect(ok("https://co.uk/t", "https://b.co.uk/rpc")).toBe(false);
  });
  it("shared hosting suffix: a.github.io vs b.github.io differ", () => {
    expect(ok("https://a.github.io/t", "https://b.github.io/rpc")).toBe(false);
    expect(ok("https://auth.a.github.io/t", "https://a.github.io/rpc")).toBe(true);
    expect(ok("https://x.vercel.app/t", "https://y.vercel.app/rpc")).toBe(false);
  });
  it("connector host that is itself a suffix needs exact equality", () => {
    expect(ok("https://github.io/t", "https://github.io/rpc")).toBe(true);
    expect(ok("https://evil.github.io/t", "https://github.io/rpc")).toBe(false);
  });
  it("single-label host requires exact equality", () => {
    expect(ok("https://localhost/t", "https://localhost:3000/rpc")).toBe(true);
    expect(ok("https://auth.localhost/t", "https://localhost/rpc")).toBe(false);
  });
  it("invalid URLs fail closed", () => {
    expect(ok("not a url", M)).toBe(false);
    expect(ok("https://auth.example.com/t", "::::")).toBe(false);
    expect(ok("", "")).toBe(false);
  });
  it("IDN via punycode", () => {
    expect(ok("https://auth.bücher.de/t", "https://mcp.bücher.de/rpc")).toBe(true);
    expect(ok("https://xn--bcher-kva.de/t", "https://mcp.bücher.de/rpc")).toBe(true);
    expect(ok("https://bücher.evil.de/t", "https://mcp.bücher.de/rpc")).toBe(false);
  });
});
