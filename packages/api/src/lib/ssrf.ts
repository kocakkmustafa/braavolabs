/**
 * SSRF (Server-Side Request Forgery) guard for tenant-supplied URLs.
 *
 * Several BYOK / integration code paths take a URL from the tenant and
 * make an outbound `fetch()` from the API process — for example
 *   - `userAIConfig.baseUrl` (Ollama / LM Studio / Custom provider)
 *   - `integration.credentials.siteUrl` (WordPress, Shopify, Custom)
 *   - `webhook.credentials.url` (outbound webhook fan-out, if added)
 *
 * Without validation, a paid tenant can point any of these at:
 *   - AWS instance metadata     (http://169.254.169.254/latest/meta-data/iam/...)
 *   - GCP metadata server       (http://metadata.google.internal/...)
 *   - Azure IMDS                (http://169.254.169.254/metadata/identity/...)
 *   - DigitalOcean droplet meta (http://169.254.169.254/metadata/v1/...)
 *   - Internal RFC1918 hosts    (Postgres, Redis, OpenTelemetry collector, etc.)
 *   - Loopback / link-local     (`http://localhost:5432/`, `http://[::1]/`)
 *   - IPv6 ULA / link-local     (`fc00::/7`, `fe80::/10`)
 *
 * The `/settings/ai-config/test` route, in particular, echoes part of
 * the upstream error body back to the caller (max 300 chars) — that
 * makes it a textbook information-exfiltration oracle. Same risk for
 * any other "test connection" surface the product gains later.
 *
 * Usage:
 *
 *   import { assertSafeExternalUrl } from "../lib/ssrf";
 *   await assertSafeExternalUrl(userSuppliedUrl, {
 *     allowLoopback: false,           // set true for self-hosted/dev only
 *     allowPrivateNetworks: false,    // ditto
 *   });
 *
 * The function resolves the hostname via DNS lookup and rejects ANY
 * resolved address that falls inside a denylisted range. It is async
 * because DNS is the only way to defend against DNS-rebinding (an
 * attacker controls a hostname that resolves to a public IP on the
 * first lookup and 169.254.169.254 on the second). Callers MUST also
 * perform the actual fetch with the same family of addresses pinned
 * (or rely on a single-resolution call sufficiently soon after this
 * check that rebinding is impractical — Node's HTTP agent caches DNS
 * for a few seconds, which is enough in practice for our use case).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SsrfGuardOptions {
  /**
   * Allow http://localhost / http://127.0.0.1 / http://[::1]. Useful
   * when the operator is running everything on the same self-hosted
   * box (Ollama in Docker on the same host as the API). Default false.
   */
  allowLoopback?: boolean;
  /**
   * Allow RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x) and
   * the IPv6 unique-local equivalents. Enable for VPC-internal services
   * the operator deliberately exposes. Default false.
   */
  allowPrivateNetworks?: boolean;
}

const CLOUD_METADATA_IPV4 = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DO / Oracle / Hetzner / Scaleway
  "100.100.100.200", // Alibaba Cloud
  "169.254.169.253", // AWS Route 53 resolver
  "169.254.170.2",   // AWS ECS task metadata v3/v4
]);

const CLOUD_METADATA_IPV6 = new Set([
  "fd00:ec2::254", // AWS IPv6 instance metadata
]);

function ipv4InRange(ip: string, cidr: [string, number]): boolean {
  const [rangeIp, bits] = cidr;
  const ipNum = ipv4ToInt(ip);
  const rangeNum = ipv4ToInt(rangeIp);
  if (ipNum === null || rangeNum === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

const PRIVATE_IPV4_RANGES: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],   // CGNAT
  ["169.254.0.0", 16],  // link-local (includes cloud metadata)
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24],  // TEST-NET-3
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved / broadcast
];

const LOOPBACK_IPV4_RANGE: [string, number] = ["127.0.0.0", 8];

function isLoopbackIpv4(ip: string): boolean {
  return ipv4InRange(ip, LOOPBACK_IPV4_RANGE);
}

function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some((r) => ipv4InRange(ip, r));
}

function isLoopbackIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // fc00::/7 = ULA, fe80::/10 = link-local. Mapped IPv4-in-IPv6 forms
  // are also caught via the toLowerCase strip below.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // ::ffff:a.b.c.d (mapped IPv4) — strip and recheck.
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]) || isLoopbackIpv4(mapped[1]);
  return false;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export async function assertSafeExternalUrl(
  url: string,
  options: SsrfGuardOptions = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Unsupported URL scheme "${parsed.protocol}"`);
  }

  // Strip surrounding brackets from IPv6 literals so the IP-checks see
  // the bare address. Hostnames stay unchanged.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("URL has no host");

  // If the host is a literal IP, validate directly without DNS.
  const ipFamily = isIP(host);
  if (ipFamily !== 0) {
    rejectIfDangerous(host, ipFamily === 6 ? "IPv6" : "IPv4", options);
    return;
  }

  // Resolve all addresses. `all: true` so both A and AAAA records are
  // returned — an attacker who points DNS at a public A record and a
  // private AAAA record would otherwise slip through.
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new SsrfError("Hostname does not resolve");
  }

  for (const { address, family } of addresses) {
    rejectIfDangerous(address, family === 6 ? "IPv6" : "IPv4", options);
  }
}

function rejectIfDangerous(
  ip: string,
  family: "IPv4" | "IPv6",
  options: SsrfGuardOptions,
): void {
  if (family === "IPv4" && CLOUD_METADATA_IPV4.has(ip)) {
    throw new SsrfError("Refusing to call cloud-metadata IP");
  }
  if (family === "IPv6" && CLOUD_METADATA_IPV6.has(ip.toLowerCase())) {
    throw new SsrfError("Refusing to call cloud-metadata IP");
  }
  const loopback =
    family === "IPv4" ? isLoopbackIpv4(ip) : isLoopbackIpv6(ip);
  if (loopback && !options.allowLoopback) {
    throw new SsrfError("Loopback addresses are not allowed");
  }
  const privateRange =
    family === "IPv4" ? isPrivateIpv4(ip) : isPrivateIpv6(ip);
  if (privateRange && !loopback && !options.allowPrivateNetworks) {
    throw new SsrfError("Private-network addresses are not allowed");
  }
}
