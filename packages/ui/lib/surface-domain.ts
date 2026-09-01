export const PUBLIC_HOST = "www.braavolabs.com";
export const APEX_HOST = "braavolabs.com";
export const AUTHENTICATED_HOST = "app.braavolabs.com";
const OFFICIAL_API_HOST = "api.braavolabs.com";

export type ProductSurface = "public" | "authenticated" | "shared";
export type SurfaceHost = "public" | "authenticated" | "local" | "invalid";

const PUBLIC_CANONICAL_ALIASES = new Map([
  ["/destek", "/support"],
  ["/legal/privacy", "/privacy"],
  ["/legal/terms", "/terms"],
]);

const PUBLIC_EXACT_PATHS = new Set([
  "/",
  "/features",
  "/pricing",
  "/security",
  "/docs",
  "/download",
  "/install",
  "/install.sh",
  "/status",
  "/support",
  "/about",
  "/blog",
  "/changelog",
  "/compare",
  "/contact",
  "/cookies",
  "/cost-calculator",
  "/gdpr",
  "/kvkk",
  "/privacy",
  "/terms",
  "/legal/account-deletion",
]);

const PUBLIC_PREFIXES = ["/docs/", "/blog/", "/download/", "/install/"];
const AUTHENTICATED_EXACT_PATHS = new Set(["/forge", "/forge-home"]);
const AUTHENTICATED_PREFIXES = ["/forge/", "/forge-home/"];
const SHARED_PREFIXES = ["/_next/", "/favicon", "/icon", "/apple-icon", "/og-image"];
const SHARED_EXACT_PATHS = new Set(["/robots.txt", "/sitemap.xml", "/braavolabs-logo.png"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const OFFICIAL_HOSTS = new Set([PUBLIC_HOST, APEX_HOST, AUTHENTICATED_HOST, OFFICIAL_API_HOST]);
const EMPTY_SELF_HOSTED_HOSTS: ReadonlySet<string> = new Set();

type IpLiteral = { version: 4; octets: readonly number[] } | { version: 6; words: readonly number[] };

function parseIpLiteral(host: string): IpLiteral | null {
  if (host.startsWith("[") && host.endsWith("]")) {
    const value = host.slice(1, -1);
    const halves = value.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    return {
      version: 6,
      words: [...left.map((word) => Number.parseInt(word, 16)), ...Array(missing).fill(0), ...right.map((word) => Number.parseInt(word, 16))],
    };
  }

  if (!/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i.test(host)) return null;
  try {
    const canonical = new URL(`http://${host}`).hostname;
    const octets = canonical.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    return { version: 4, octets };
  } catch {
    return null;
  }
}

function isForbiddenIpv4([a, b, c]: readonly number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isForbiddenIpv6(words: readonly number[]): boolean {
  const [a, b, c, d, e, f] = words;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (ipv4Mapped) return true;
  return (
    allZero ||
    loopback ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b <= 0x01ff) ||
    (a === 0x2001 && b === 0x0db8) ||
    a === 0x2002 ||
    (a === 0x3fff && (b & 0xf000) === 0) ||
    (a & 0xe000) !== 0x2000
  );
}

function isForbiddenSelfHostedHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host) || OFFICIAL_HOSTS.has(host)) return true;
  const ip = parseIpLiteral(host);
  if (!ip) return false;
  return ip.version === 4 ? isForbiddenIpv4(ip.octets) : isForbiddenIpv6(ip.words);
}

export function normalizeSurfaceHost(host: string | null): string {
  const candidate = (host ?? "").trim().toLowerCase();
  if (!candidate || candidate.includes("@") || candidate.includes(",") || /[\s/\\]/.test(candidate)) return "";

  if (candidate.startsWith("[")) {
    const match = candidate.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i);
    if (!match || (match[2] && Number(match[2]) > 65535)) return "";
    const ipv6Host = `[${match[1]}]`;
    const parsedIp = parseIpLiteral(ipv6Host);
    if (!parsedIp || parsedIp.version !== 6) return "";
    return ipv6Host;
  }

  const match = candidate.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  if (!match || (match[2] && Number(match[2]) > 65535)) return "";
  let hostname = match[1];
  if (hostname.endsWith("..")) return "";
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) return "";
  return hostname;
}

export function parseSelfHostedSurfaceHosts(raw: string | null | undefined): ReadonlySet<string> {
  const candidate = raw?.trim();
  if (!candidate) return EMPTY_SELF_HOSTED_HOSTS;

  const normalizedHosts = new Set<string>();
  for (const entry of candidate.split(",")) {
    const normalizedHost = normalizeSurfaceHost(entry.trim());
    if (!normalizedHost || isForbiddenSelfHostedHost(normalizedHost)) {
      return EMPTY_SELF_HOSTED_HOSTS;
    }
    normalizedHosts.add(normalizedHost);
  }
  return normalizedHosts;
}

export function parseSelfHostedApiCspSources(raw: string | null | undefined): readonly string[] | null {
  const candidate = raw?.trim();
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//") || /[\\\s?#]/.test(candidate)) return null;
    return [];
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(candidate);
  } catch {
    return null;
  }

  const normalizedHost = normalizeSurfaceHost(apiUrl.host);
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    !normalizedHost ||
    isForbiddenSelfHostedHost(normalizedHost)
  ) {
    return null;
  }

  const websocketOrigin = new URL(apiUrl.origin);
  websocketOrigin.protocol = "wss:";
  return [apiUrl.origin, websocketOrigin.origin];
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function classifySurfacePath(pathname: string): ProductSurface {
  const normalized = normalizePathname(pathname);
  if (SHARED_EXACT_PATHS.has(normalized) || SHARED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "shared";
  }
  if (
    AUTHENTICATED_EXACT_PATHS.has(normalized) ||
    AUTHENTICATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "authenticated";
  }
  if (PUBLIC_CANONICAL_ALIASES.has(normalized)) return "public";
  if (PUBLIC_EXACT_PATHS.has(normalized) || PUBLIC_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "public";
  }
  return "authenticated";
}

export function isPublicInstallerPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/install" || normalized === "/install.sh" || normalized.startsWith("/install/");
}

export function isPublicDownloadPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/download" || normalized.startsWith("/download/");
}

function canonicalUrl(host: string, pathname: string, search: string): URL {
  return new URL(`https://${host}${pathname}${search}`);
}

export function getSurfaceRedirect(
  host: string | null,
  pathname: string,
  search = "",
  selfHostedHosts: ReadonlySet<string> = EMPTY_SELF_HOSTED_HOSTS,
): URL | null {
  const normalizedHost = normalizeSurfaceHost(host);
  const normalizedPath = normalizePathname(pathname);
  const surface = classifySurfacePath(normalizedPath);
  const canonicalAlias = PUBLIC_CANONICAL_ALIASES.get(normalizedPath);
  const selfHostedHost = selfHostedHosts.has(normalizedHost);

  const recognizedHost =
    normalizedHost === PUBLIC_HOST ||
    normalizedHost === APEX_HOST ||
    normalizedHost === AUTHENTICATED_HOST ||
    LOCAL_HOSTS.has(normalizedHost) ||
    selfHostedHost;
  if (!recognizedHost) return null;

  if (selfHostedHost) {
    if (canonicalAlias) return canonicalUrl(normalizedHost, canonicalAlias, search);
    if (isPublicDownloadPath(normalizedPath)) {
      return canonicalUrl(normalizedHost, "/docs/getting-started", search);
    }
    return null;
  }

  if (canonicalAlias && !LOCAL_HOSTS.has(normalizedHost)) {
    return canonicalUrl(PUBLIC_HOST, canonicalAlias, search);
  }

  if (isPublicDownloadPath(normalizedPath) && !LOCAL_HOSTS.has(normalizedHost)) {
    return canonicalUrl(PUBLIC_HOST, "/docs/getting-started", search);
  }

  if (normalizedHost === APEX_HOST) {
    return canonicalUrl(surface === "authenticated" ? AUTHENTICATED_HOST : PUBLIC_HOST, normalizedPath, search);
  }
  if (normalizedHost === PUBLIC_HOST && surface === "authenticated") {
    return canonicalUrl(AUTHENTICATED_HOST, normalizedPath, search);
  }
  if (normalizedHost === AUTHENTICATED_HOST && surface === "public") {
    return canonicalUrl(PUBLIC_HOST, normalizedPath, search);
  }
  return null;
}

export function surfaceForHost(
  host: string | null,
  pathname = "/",
  selfHostedHosts: ReadonlySet<string> = EMPTY_SELF_HOSTED_HOSTS,
): SurfaceHost {
  const normalizedHost = normalizeSurfaceHost(host);
  if (normalizedHost === PUBLIC_HOST || normalizedHost === APEX_HOST) return "public";
  if (normalizedHost === AUTHENTICATED_HOST) return "authenticated";
  if (LOCAL_HOSTS.has(normalizedHost)) return "local";
  if (selfHostedHosts.has(normalizedHost)) {
    return classifySurfacePath(pathname) === "authenticated" ? "authenticated" : "public";
  }
  return "invalid";
}
