import { describe, it, expect } from "vitest";
import { assertSafeExternalUrl, SsrfError } from "../ssrf";

// Literal-IP cases skip DNS, so these are hermetic (no network). Focus on the
// IPv4-mapped IPv6 hex bypass the second-pass review found: `new URL` emits
// the host as `::ffff:a9fe:a9fe` (hex), not dotted-decimal.
describe("assertSafeExternalUrl — IPv4-mapped IPv6 hex bypass (FINDINGS C1 second-pass)", () => {
  it("blocks hex-mapped internal/metadata literals", async () => {
    for (const u of [
      "http://[::ffff:169.254.169.254]/latest/meta-data/", // a9fe:a9fe
      "http://[::ffff:127.0.0.1]:5432/", // 7f00:1
      "http://[::ffff:10.0.0.1]/", // a00:1
      "http://[::ffff:192.168.0.1]/", // c0a8:1
    ]) {
      await expect(assertSafeExternalUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("blocks dotted-decimal mapped + bare internal literals", async () => {
    for (const u of [
      "http://[::ffff:169.254.169.254]/",
      "http://169.254.169.254/",
      "http://127.0.0.1/",
      "http://[::1]/",
    ]) {
      await expect(assertSafeExternalUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("allows a mapped PUBLIC address (no false positive)", async () => {
    await expect(assertSafeExternalUrl("https://[::ffff:808:808]/")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeExternalUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
  });
});
