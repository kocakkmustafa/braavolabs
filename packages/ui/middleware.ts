import { NextRequest, NextResponse } from "next/server";
import {
  getSurfaceRedirect,
  isPublicInstallerPath,
  normalizeSurfaceHost,
  parseSelfHostedApiCspSources,
  parseSelfHostedSurfaceHosts,
  surfaceForHost,
} from "./lib/surface-domain";

const DEVELOPMENT_SCRIPT_EVAL = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const PUBLIC_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEVELOPMENT_SCRIPT_EVAL} https://static.cloudflareinsights.com https://plausible.io`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  // /status probes the API's public HTTPS health endpoint; no websocket here.
  "connect-src 'self' https://api.braavolabs.com https://cloudflareinsights.com https://plausible.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://app.braavolabs.com",
].join("; ");

const AUTHENTICATED_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEVELOPMENT_SCRIPT_EVAL}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  "connect-src 'self' https://api.braavolabs.com wss://api.braavolabs.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Self-hosted public pages may reach only the configured API's HTTPS origin
// (the /status health probe); its websocket origin stays authenticated-only.
function selfHostedPublicCsp(apiSources: readonly string[] | null): string {
  const apiOrigin = (apiSources ?? []).filter((source) => source.startsWith("https://"));
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${DEVELOPMENT_SCRIPT_EVAL} https://static.cloudflareinsights.com https://plausible.io`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${["'self'", ...apiOrigin, "https://cloudflareinsights.com", "https://plausible.io"].join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function selfHostedAuthenticatedCsp(apiSources: readonly string[]): string {
  const connectSources = ["'self'", ...apiSources].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${DEVELOPMENT_SCRIPT_EVAL}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
    `connect-src ${connectSources}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function misdirectedRequest() {
  return new NextResponse("Unrecognized request host.\n", {
    status: 421,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PUBLIC_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function hasTrustedSelfHostedForwardedProto(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "https";
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  const normalizedHost = normalizeSurfaceHost(host);
  const selfHostedHosts = parseSelfHostedSurfaceHosts(process.env.SELF_HOSTED_SURFACE_HOSTS);
  const selfHostedHost = selfHostedHosts.has(normalizedHost);
  const selfHostedApiSources = parseSelfHostedApiCspSources(process.env.NEXT_PUBLIC_API_URL);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (selfHostedHost && !hasTrustedSelfHostedForwardedProto(request.headers.get("x-forwarded-proto"))) {
    return misdirectedRequest();
  }
  if (forwardedHost !== null) {
    const normalizedForwardedHost = normalizeSurfaceHost(forwardedHost);
    if (!normalizedForwardedHost || normalizedForwardedHost !== normalizedHost) return misdirectedRequest();
  }

  const redirect = getSurfaceRedirect(host, request.nextUrl.pathname, request.nextUrl.search, selfHostedHosts);

  // A permanent response is returned before Next resolves a route. No tenant
  // component, dashboard fetch, or auth-cookie producer runs on the wrong host.
  if (redirect) return NextResponse.redirect(redirect, 308);

  const surface = surfaceForHost(host, request.nextUrl.pathname, selfHostedHosts);
  if (surface === "invalid" || (surface === "local" && process.env.NODE_ENV !== "development")) {
    return misdirectedRequest();
  }
  if (selfHostedHost && surface === "authenticated" && selfHostedApiSources === null) {
    return misdirectedRequest();
  }

  if (surface === "public" && isPublicInstallerPath(request.nextUrl.pathname)) {
    return new NextResponse(
      "The Braavolabs CLI installer is not publicly available. See https://www.braavolabs.com/docs/getting-started for current setup options.\n",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "x-braavolabs-surface": "public",
          "Content-Security-Policy": selfHostedHost ? selfHostedPublicCsp(selfHostedApiSources) : PUBLIC_CSP,
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("x-braavolabs-pathname", request.nextUrl.pathname);
  forwardedHeaders.set("x-braavolabs-surface", surface);
  const response = NextResponse.next({ request: { headers: forwardedHeaders } });
  response.headers.set("x-braavolabs-surface", surface);
  const contentSecurityPolicy = selfHostedHost
    ? surface === "public"
      ? selfHostedPublicCsp(selfHostedApiSources)
      : selfHostedAuthenticatedCsp(selfHostedApiSources ?? [])
    : surface === "public"
      ? PUBLIC_CSP
      : AUTHENTICATED_CSP;
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
