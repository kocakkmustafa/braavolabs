import { NextRequest, NextResponse } from "next/server";
import { getSurfaceRedirect, surfaceForHost } from "./lib/surface-domain";

const PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://plausible.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com https://plausible.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://app.braavolabs.com",
].join("; ");

const AUTHENTICATED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  "connect-src 'self' https://api.braavolabs.com wss://api.braavolabs.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  const redirect = getSurfaceRedirect(host, request.nextUrl.pathname, request.nextUrl.search);

  // A permanent response is returned before Next resolves a route. No tenant
  // component, dashboard fetch, or auth-cookie producer runs on the wrong host.
  if (redirect) return NextResponse.redirect(redirect, 308);

  const surface = surfaceForHost(host);
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("x-braavolabs-pathname", request.nextUrl.pathname);
  forwardedHeaders.set("x-braavolabs-surface", surface);
  const response = NextResponse.next({ request: { headers: forwardedHeaders } });
  response.headers.set("x-braavolabs-surface", surface);
  response.headers.set("Content-Security-Policy", surface === "public" ? PUBLIC_CSP : AUTHENTICATED_CSP);
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
