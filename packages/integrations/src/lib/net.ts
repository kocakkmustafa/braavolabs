/**
 * Outbound-network safety for integration adapters.
 *
 * FINDINGS H4 / H6 — integration adapters POST to tenant-supplied URLs
 * (n8n webhook URL, Slack/Discord incoming webhooks, generic collectors).
 * The previous n8n guard string-matched private IP literals only, which
 * a hostname that resolves to 127.0.0.1 / 169.254.169.254 (cloud
 * metadata) trivially bypasses (DNS rebinding). This module:
 *   - resolves the host (A + AAAA) and rejects any address in a
 *     private/loopback/link-local/CGNAT/metadata range,
 *   - rejects non-http(s) schemes,
 *   - wraps fetch with an AbortController timeout and bounded
 *     exponential-backoff retry so a single slow/flapping upstream can't
 *     pin a worker or silently drop the delivery.
 *
 * Residual: a pure DNS-rebinding race (DNS answer changes between this
 * check and the socket connect) is not fully closed here — the platform
 * API package (`packages/api/src/lib/ssrf.ts`) documents the same caveat.
 * Resolving + checking every returned address defeats the common cases.
 */

import dns from "node:dns/promises";
import net from "node:net";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * Decode an IPv4-mapped IPv6 address (::ffff:0:0/96) to its embedded dotted
 * IPv4, handling BOTH the dotted-decimal tail (`::ffff:10.0.0.1`) AND the hex
 * tail that `new URL`/Node normalisation actually emits (`::ffff:a00:1`), plus
 * the fully-expanded `0:0:0:0:0:ffff:...` form. Returns null for non-mapped
 * addresses. The high-80-bits-zero anchor prevents false-positives on real
 * public IPv6 addresses that merely end in `:ffff:xxxx:xxxx`.
 */
function ipv4MappedToV4(v6: string): string | null {
  const lower = v6.toLowerCase();
  if (!/^(::ffff:|0:0:0:0:0:ffff:)/.test(lower)) return null;
  const tail = lower.replace(/^(::ffff:|0:0:0:0:0:ffff:)/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hm = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hm) {
    const hi = parseInt(hm[1]!, 16);
    const lo = parseInt(hm[2]!, 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

/** True for any address an outbound integration must never reach. */
export function isBlockedAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) {
    return (
      inV4Cidr(addr, "0.0.0.0", 8) || // "this" network / 0.0.0.0
      inV4Cidr(addr, "10.0.0.0", 8) || // RFC1918
      inV4Cidr(addr, "172.16.0.0", 12) || // RFC1918
      inV4Cidr(addr, "192.168.0.0", 16) || // RFC1918
      inV4Cidr(addr, "127.0.0.0", 8) || // loopback
      inV4Cidr(addr, "169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
      inV4Cidr(addr, "100.64.0.0", 10) || // CGNAT
      inV4Cidr(addr, "192.0.0.0", 24) || // IETF protocol assignments
      inV4Cidr(addr, "192.0.2.0", 24) || // TEST-NET-1
      inV4Cidr(addr, "198.18.0.0", 15) || // benchmarking
      inV4Cidr(addr, "198.51.100.0", 24) || // TEST-NET-2
      inV4Cidr(addr, "203.0.113.0", 24) || // TEST-NET-3
      inV4Cidr(addr, "224.0.0.0", 4) || // multicast
      inV4Cidr(addr, "240.0.0.0", 4) // reserved
    );
  }
  if (family === 6) {
    const v6 = addr.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d). CRITICAL: `new URL('http://[::ffff:10.0.0.1]/')`
    // normalises the host to the HEX form `::ffff:a00:1`, NOT dotted-decimal —
    // a dotted-only regex was bypassable (::ffff:a9fe:a9fe == 169.254.169.254
    // metadata). Decode BOTH spellings to the embedded v4 and re-check.
    const mapped = ipv4MappedToV4(v6);
    if (mapped) return isBlockedAddress(mapped);
    if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
    if (v6.startsWith("fe80:") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
    if (v6.startsWith("ff")) return true; // multicast
    if (v6.startsWith("64:ff9b:")) return true; // NAT64
    return false;
  }
  return true; // not a recognisable IP → block
}

/**
 * Validate a tenant-supplied URL is safe to call. Resolves DNS and checks
 * every returned address. Throws on any violation.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`Refusing to call blocked address: ${host}`);
    return url;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for host: ${host}`);
  }
  if (addrs.length === 0) throw new Error(`No addresses resolved for host: ${host}`);
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new Error(`Refusing to call host resolving to blocked address: ${host} → ${a.address}`);
    }
  }
  return url;
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  retries?: number;
  /** Skip SSRF validation (e.g. fixed first-party host). Default false. */
  skipUrlGuard?: boolean;
}

/**
 * fetch() with SSRF validation, an AbortController timeout, and bounded
 * exponential-backoff retry. Retries on network error / timeout / 5xx /
 * 429; never retries 4xx (other than 429). Throws after the last attempt.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  if (!opts.skipUrlGuard) await assertPublicUrl(url);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        lastErr = new Error(`upstream ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
    // Exponential backoff: 250ms, 500ms, 1s, … (deterministic, no jitter
    // dependency — keeps the helper pure/testable).
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
