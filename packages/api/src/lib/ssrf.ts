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
 * `safeExternalFetch` resolves and validates every address, then binds the
 * selected address to the actual socket through a custom lookup callback.
 * Redirects are handled manually and each target is independently resolved
 * before another socket is opened. Callers of tenant-controlled endpoints
 * MUST use that primitive rather than separating validation from `fetch()`.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";

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
  /**
   * Require every resolved address to be an explicitly local destination:
   * loopback, RFC1918, IPv4 link-local, IPv6 ULA, or IPv6 link-local.
   * This grants no access by itself and is intended for explicit offline
   * provider transports. Metadata addresses remain denied in every mode.
   */
  requireLocalDestination?: boolean;
  /**
   * Require TLS for every request and redirect hop. Offline/local callers
   * deliberately leave this false so operator-owned HTTP endpoints remain
   * usable; credential-bearing SaaS transports set it true.
   */
  requireHttps?: boolean;
}

export interface SafeExternalFetchOptions extends SsrfGuardOptions {
  /** Maximum same-origin redirects. Default 5. */
  maxRedirects?: number;
  /**
   * Redirect handling remains same-origin unless a credential-free public
   * GET/HEAD caller explicitly opts into independently validated HTTPS hops.
   */
  redirectPolicy?: "same-origin" | "validated-public-https";
  /** Caller-specific response ceiling. Default and maximum: 16 MiB. */
  maxResponseBytes?: number;
  /**
   * `error` preserves the provider fail-closed default. `truncate` returns the
   * exact bounded prefix and closes the response socket at the byte limit.
   */
  responseOverflow?: "error" | "truncate";
  /**
   * Materialize sensitive request fields only after the initial destination
   * has passed validation and immediately before the pinned request opens.
   */
  prepareRequest?: () => RequestInit | Promise<RequestInit>;
}

interface SafeAddress {
  address: string;
  family: 4 | 6;
}

const CLOUD_METADATA_IPV4 = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DO / Oracle / Hetzner / Scaleway
  "100.100.100.200", // Alibaba Cloud
  "169.254.169.253", // AWS Route 53 resolver
  "169.254.170.2",   // AWS ECS task metadata v3/v4
  "169.254.170.23",  // AWS EKS Pod Identity credentials
  "169.254.0.23",    // Tencent Cloud instance metadata
]);

const CLOUD_METADATA_IPV6 = new Set([
  "fd00:ec2::254", // AWS IPv6 instance metadata
  "fd00:ec2::23",  // AWS EKS Pod Identity credentials
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
  ["0.0.0.0", 8],     // unspecified / current host
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
const LOCAL_IPV4_RANGES: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
];

function isLoopbackIpv4(ip: string): boolean {
  return ipv4InRange(ip, LOOPBACK_IPV4_RANGE);
}

function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some((r) => ipv4InRange(ip, r));
}

function isPermittedLocalIpv4(ip: string): boolean {
  return isLoopbackIpv4(ip) || LOCAL_IPV4_RANGES.some((range) => ipv4InRange(ip, range));
}

function isLoopbackIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

/**
 * Decode an IPv4-mapped IPv6 address (::ffff:0:0/96) to its embedded dotted
 * IPv4 — handling the dotted-decimal tail (`::ffff:10.0.0.1`), the HEX tail
 * that `new URL` normalisation actually emits (`::ffff:a00:1`), and the
 * fully-expanded `0:0:0:0:0:ffff:...` form. The high-80-bits-zero anchor
 * prevents false-positives on public IPv6 addresses ending in `:ffff:x:x`.
 */
function ipv4MappedToV4(lower: string): string | null {
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

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // fc00::/7 = ULA, fe80::/10 = link-local.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  return false;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let normalized = ip.toLowerCase();
  const dottedTail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dottedTail) {
    const v4 = ipv4ToInt(dottedTail);
    if (v4 === null) return null;
    normalized = normalized.slice(0, -dottedTail.length) +
      `${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (zeroCount < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const parts = [...left, ...Array(zeroCount).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InRange(ip: string, range: string, bits: number): boolean {
  const value = ipv6ToBigInt(ip);
  const base = ipv6ToBigInt(range);
  if (value === null || base === null || bits < 0 || bits > 128) return false;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

function isUnsafeSpecialIpv6(ip: string): boolean {
  // Default outbound SaaS policy accepts real global-unicast IPv6 only.
  // Documentation, transition and tunnelling prefixes are not destinations
  // an application provider endpoint should ever need.
  if (!ipv6InRange(ip, "2000::", 3)) return true;
  return (
    ipv6InRange(ip, "2001::", 32) || // Teredo
    ipv6InRange(ip, "2001:db8::", 32) || // documentation
    ipv6InRange(ip, "2002::", 16) // 6to4, can embed private/link-local v4
  );
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
  await resolveSafeTarget(url, options);
}

function abortError(): DOMException {
  return new DOMException("Outbound request aborted", "AbortError");
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveSafeTarget(
  input: string | URL,
  options: SsrfGuardOptions,
  signal?: AbortSignal | null,
): Promise<{ url: URL; address: SafeAddress }> {
  if (signal?.aborted) throw abortError();
  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new SsrfError("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Unsupported URL scheme "${parsed.protocol}"`);
  }
  if (options.requireHttps && parsed.protocol !== "https:") {
    throw new SsrfError("HTTPS is required for this destination");
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError("URL credentials are not allowed");
  }

  // Strip surrounding brackets from IPv6 literals so the IP-checks see
  // the bare address. Hostnames stay unchanged.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("URL has no host");

  // If the host is a literal IP, validate directly without DNS.
  const ipFamily = isIP(host);
  if (ipFamily !== 0) {
    const family = ipFamily === 6 ? 6 : 4;
    rejectIfDangerous(host, family === 6 ? "IPv6" : "IPv4", options);
    return { url: parsed, address: { address: host, family } };
  }

  // Resolve all addresses. `all: true` so both A and AAAA records are
  // returned — an attacker who points DNS at a public A record and a
  // private AAAA record would otherwise slip through.
  let addresses: Array<{ address: string; family: number }> = [];
  try {
    addresses = await awaitWithAbort(dnsLookup(host, { all: true }), signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new SsrfError("Hostname does not resolve");
  }
  if (addresses.length === 0) throw new SsrfError("Hostname has no addresses");

  for (const { address, family } of addresses) {
    if (family !== 4 && family !== 6) throw new SsrfError("Unsupported DNS address family");
    rejectIfDangerous(address, family === 6 ? "IPv6" : "IPv4", options);
  }
  const selected = addresses[0]!;
  return {
    url: parsed,
    address: { address: selected.address, family: selected.family as 4 | 6 },
  };
}

/** Build a request that keeps the URL hostname for Host/TLS SNI while the
 * socket resolver can return only the address already validated above. */
export function buildPinnedRequestOptions(
  target: URL,
  pinned: SafeAddress,
  init: RequestInit = {},
): RequestOptions {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const headers = new Headers(init.headers);
  // Never let a caller detach Host from the authority that passed validation.
  headers.set("host", target.host);
  const normalizedHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { normalizedHeaders[key] = value; });

  const lookup = ((
    _hostname: string,
    optionsOrCallback: unknown,
    optionalCallback?: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
  ) => {
    const callback = typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : optionalCallback;
    if (!callback) throw new SsrfError("Pinned DNS callback missing");
    if (
      typeof optionsOrCallback === "object" &&
      optionsOrCallback !== null &&
      "all" in optionsOrCallback &&
      optionsOrCallback.all === true
    ) {
      (callback as unknown as (
        error: NodeJS.ErrnoException | null,
        addresses: SafeAddress[],
      ) => void)(null, [pinned]);
      return;
    }
    (callback as unknown as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: 4 | 6,
    ) => void)(null, pinned.address, pinned.family);
  }) as LookupFunction;

  return {
    protocol: target.protocol,
    hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: init.method ?? "GET",
    headers: normalizedHeaders,
    signal: init.signal ?? undefined,
    lookup,
    ...(target.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
}

function normalizeRequestBody(
  body: RequestInit["body"] | null | undefined,
): string | Buffer | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new SsrfError("Unsupported outbound request body");
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
  }
  return headers;
}

function requestPinned(
  target: URL,
  address: SafeAddress,
  init: RequestInit,
  maxResponseBytes: number,
  responseOverflow: "error" | "truncate",
): Promise<Response> {
  const options = buildPinnedRequestOptions(target, address, init);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body = normalizeRequestBody(init.body);

  return new Promise<Response>((resolve, reject) => {
    const request = requestImpl(options, (message) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const headers = responseHeaders(message);
      const finish = (body: Buffer, truncated = false) => {
        if (settled) return;
        if (truncated) headers.delete("content-length");
        const status = message.statusCode ?? 502;
        const bodyless = init.method?.toUpperCase() === "HEAD" ||
          status === 204 || status === 205 || status === 304;
        try {
          const response = new Response(bodyless ? null : body, {
            status,
            statusText: message.statusMessage,
            headers,
          });
          settled = true;
          resolve(response);
        } catch (error) {
          settled = true;
          message.destroy();
          reject(error instanceof Error ? error : new Error("Invalid provider response"));
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        message.destroy();
        reject(error);
      };
      message.on("aborted", () => fail(new Error("Provider response aborted")));
      message.on("error", fail);

      // Redirect bodies are never consumed. The caller will validate the next
      // authority before opening another socket.
      if (
        REDIRECT_STATUSES.has(message.statusCode ?? 0) &&
        headers.has("location")
      ) {
        settled = true;
        message.destroy();
        resolve(new Response(null, {
          status: message.statusCode ?? 302,
          statusText: message.statusMessage,
          headers,
        }));
        return;
      }

      message.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxResponseBytes - bytes;
        if (responseOverflow === "truncate" && buffer.length >= remaining) {
          if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
          bytes = maxResponseBytes;
          finish(Buffer.concat(chunks, bytes), true);
          message.destroy();
          return;
        }
        if (buffer.length > remaining) {
          fail(new SsrfError("Provider response exceeds safe limit"));
          return;
        }
        bytes += buffer.length;
        chunks.push(buffer);
      });
      message.on("end", () => {
        finish(Buffer.concat(chunks, bytes));
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CROSS_ORIGIN_PUBLIC_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
]);

function publicRedirectRequest(init: RequestInit): RequestInit {
  const headers = new Headers();
  new Headers(init.headers).forEach((value, key) => {
    if (CROSS_ORIGIN_PUBLIC_HEADERS.has(key)) headers.set(key, value);
  });
  return { ...init, headers, body: undefined };
}

/** Fetch a tenant-selected external URL without a DNS validation/use race. */
export async function safeExternalFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeExternalFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new SsrfError("Invalid redirect limit");
  }
  const redirectPolicy = options.redirectPolicy ?? "same-origin";
  if (redirectPolicy !== "same-origin" && redirectPolicy !== "validated-public-https") {
    throw new SsrfError("Invalid redirect policy");
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES
  ) {
    throw new SsrfError("Invalid response byte limit");
  }
  const responseOverflow = options.responseOverflow ?? "error";
  if (responseOverflow !== "error" && responseOverflow !== "truncate") {
    throw new SsrfError("Invalid response overflow policy");
  }
  if (responseOverflow === "truncate" && options.maxResponseBytes === undefined) {
    throw new SsrfError("Truncation requires an explicit response byte limit");
  }

  const publicRedirects = redirectPolicy === "validated-public-https";
  if (publicRedirects) {
    if (options.allowLoopback || options.allowPrivateNetworks || options.requireLocalDestination) {
      throw new SsrfError("Public redirect mode cannot allow local destinations");
    }
    if (options.prepareRequest) {
      throw new SsrfError("Public redirect mode cannot prepare credentials");
    }
    const publicMethod = (init.method ?? "GET").toUpperCase();
    if ((publicMethod !== "GET" && publicMethod !== "HEAD") || init.body != null) {
      throw new SsrfError("Public redirect mode supports GET or HEAD without a body");
    }
  }

  const guardOptions: SsrfGuardOptions = publicRedirects
    ? { ...options, requireHttps: true }
    : options;

  let target = await resolveSafeTarget(input, guardOptions, init.signal);
  const prepared = options.prepareRequest ? await options.prepareRequest() : {};
  const headers = new Headers(init.headers);
  new Headers(prepared.headers).forEach((value, key) => headers.set(key, value));
  let requestInit: RequestInit = {
    ...prepared,
    ...init,
    headers,
  };
  const method = (init.method ?? "GET").toUpperCase();
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestPinned(
      target.url,
      target.address,
      requestInit,
      maxResponseBytes,
      responseOverflow,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= maxRedirects) throw new SsrfError("Too many redirects");
    if (method !== "GET" && method !== "HEAD" && response.status !== 307 && response.status !== 308) {
      throw new SsrfError("Unsafe redirect method conversion refused");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, target.url);
    } catch {
      throw new SsrfError("Invalid redirect location");
    }
    // Resolve and validate before checking origin so even a rejected redirect
    // target is never treated as an unexamined URL in logs or follow-up code.
    const next = await resolveSafeTarget(nextUrl, guardOptions, requestInit.signal);
    const crossOrigin = next.url.origin !== target.url.origin;
    if (crossOrigin && !publicRedirects) {
      throw new SsrfError("Cross-origin redirects are not allowed");
    }
    if (crossOrigin) requestInit = publicRedirectRequest(requestInit);
    target = next;
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
  if (family === "IPv6") {
    const mapped = ipv4MappedToV4(ip.toLowerCase());
    if (mapped) {
      rejectIfDangerous(mapped, "IPv4", options);
      return;
    }
  }
  const loopback =
    family === "IPv4" ? isLoopbackIpv4(ip) : isLoopbackIpv6(ip);
  if (loopback && !options.allowLoopback) {
    throw new SsrfError("Loopback addresses are not allowed");
  }
  const privateRange =
    family === "IPv4" ? isPrivateIpv4(ip) : isPrivateIpv6(ip);
  const permittedLocalDestination = family === "IPv4"
    ? isPermittedLocalIpv4(ip)
    : loopback || isPrivateIpv6(ip);
  if (options.requireLocalDestination && !permittedLocalDestination) {
    throw new SsrfError("Destination must resolve only to a local destination");
  }
  if (privateRange && !loopback && !options.allowPrivateNetworks) {
    throw new SsrfError("Private-network addresses are not allowed");
  }
  if (family === "IPv6" && !loopback && !privateRange && isUnsafeSpecialIpv6(ip)) {
    throw new SsrfError("Non-global IPv6 addresses are not allowed");
  }
}
