import { describe, it, expect } from "vitest";
import { isBlockedAddress, assertPublicUrl } from "../net";

describe("isBlockedAddress", () => {
  it("blocks IPv4 private / loopback / link-local / CGNAT / metadata", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback / ULA / link-local / mapped-private", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::3", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 in HEX form (the form new URL emits) — SSRF bypass guard", () => {
    // `new URL('http://[::ffff:169.254.169.254]/')` normalises to ::ffff:a9fe:a9fe
    for (const ip of [
      "::ffff:a9fe:a9fe", // 169.254.169.254 metadata
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:c0a8:1", // 192.168.0.1
      "::ffff:a00:1", // 10.0.0.1
      "0:0:0:0:0:ffff:7f00:1", // expanded 127.0.0.1
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 (incl. mapped public + addresses ending in ffff)", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false); // Cloudflare
    expect(isBlockedAddress("::ffff:808:808")).toBe(false); // mapped 8.8.8.8 (public)
    expect(isBlockedAddress("2606:4700::ffff:7f00:1")).toBe(false); // NOT mapped — high bits set
  });

  it("blocks non-IP strings", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("rejects unsupported schemes", async () => {
    await expect(assertPublicUrl("ftp://example.com")).rejects.toThrow(/protocol/i);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/protocol/i);
  });

  it("rejects literal private/metadata IPs without DNS", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked/i);
    await expect(assertPublicUrl("http://127.0.0.1:4000/internal")).rejects.toThrow(/blocked/i);
    await expect(assertPublicUrl("http://[::1]/x")).rejects.toThrow(/blocked/i);
  });

  it("rejects hostnames that resolve to loopback (e.g. localhost)", async () => {
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(/blocked/i);
  });

  it("accepts a literal public IP", async () => {
    const url = await assertPublicUrl("https://1.1.1.1/");
    expect(url.hostname).toBe("1.1.1.1");
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertPublicUrl("http://")).rejects.toThrow();
  });
});
