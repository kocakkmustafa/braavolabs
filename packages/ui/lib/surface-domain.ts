export const PUBLIC_HOST = "www.braavolabs.com";
export const APEX_HOST = "braavolabs.com";
export const AUTHENTICATED_HOST = "app.braavolabs.com";

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
const SHARED_EXACT_PATHS = new Set(["/robots.txt", "/sitemap.xml"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeSurfaceHost(host: string | null): string {
  const candidate = (host ?? "").trim().toLowerCase();
  if (!candidate || candidate.includes("@") || candidate.includes(",") || /[\s/\\]/.test(candidate)) return "";

  if (candidate.startsWith("[")) {
    const match = candidate.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i);
    if (!match || (match[2] && Number(match[2]) > 65535)) return "";
    return `[${match[1]}]`;
  }

  const match = candidate.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  if (!match || (match[2] && Number(match[2]) > 65535)) return "";
  let hostname = match[1];
  if (hostname.endsWith("..")) return "";
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) return "";
  return hostname;
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

export function getSurfaceRedirect(host: string | null, pathname: string, search = ""): URL | null {
  const normalizedHost = normalizeSurfaceHost(host);
  const normalizedPath = normalizePathname(pathname);
  const surface = classifySurfacePath(normalizedPath);
  const canonicalAlias = PUBLIC_CANONICAL_ALIASES.get(normalizedPath);

  const recognizedHost =
    normalizedHost === PUBLIC_HOST ||
    normalizedHost === APEX_HOST ||
    normalizedHost === AUTHENTICATED_HOST ||
    LOCAL_HOSTS.has(normalizedHost);
  if (!recognizedHost) return null;

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

export function surfaceForHost(host: string | null): SurfaceHost {
  const normalizedHost = normalizeSurfaceHost(host);
  if (normalizedHost === PUBLIC_HOST || normalizedHost === APEX_HOST) return "public";
  if (normalizedHost === AUTHENTICATED_HOST) return "authenticated";
  if (LOCAL_HOSTS.has(normalizedHost)) return "local";
  return "invalid";
}
