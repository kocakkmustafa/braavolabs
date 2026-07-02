import type { NextConfig } from "next";
import path from "path";
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";

// next-intl runs in "without i18n routing" mode — config lives in
// ./i18n/request.ts and is wrapped around the export below.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Monorepo root (two levels up from packages/ui)
const MONOREPO_ROOT = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-company-os/core"],
  productionBrowserSourceMaps: false,
  images: { unoptimized: true },
  // Standalone output — builds a minimal server bundle in `.next/standalone/`
  // used by Dockerfile.ui. Critical for small production images (~150MB vs 1GB+).
  output: "standalone",
  // outputFileTracingRoot ensures monorepo workspace packages get copied
  // into the standalone bundle (otherwise runtime module resolution fails).
  outputFileTracingRoot: MONOREPO_ROOT,
  eslint: {
    // ESLint is run separately in CI — don't block prod build on lint warnings.
    ignoreDuringBuilds: true,
  },
  // Setting turbopack.root to the monorepo root matches what Next.js
  // auto-detects, suppressing the secondary-lockfile scan that otherwise
  // picks up git worktrees and tries to compile them.
  turbopack: {
    root: MONOREPO_ROOT,
  },
  webpack(config) {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/node_modules/**", "**/.git/**", "**/.claude/worktrees/**"],
    };
    return config;
  },
  // Strip the X-Powered-By: Next.js header — frameworks that leak their
  // identity narrow attacker exploit search.
  poweredByHeader: false,
  // Store-listing aliases. App Store Connect's Support URL points at
  // /destek and Play's privacy-policy field at /legal/privacy — both
  // reviewers hard-fail on 404s (Apple Guideline 1.5, Play pre-submit
  // check), so these must resolve even after metadata is corrected to
  // the canonical paths.
  async redirects() {
    return [
      { source: "/destek", destination: "/support", permanent: true },
      { source: "/legal/privacy", destination: "/privacy", permanent: true },
      { source: "/legal/terms", destination: "/terms", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Cloudflare auto-injects beacon.min.js for analytics on
              // proxied sites — add the static CDN host so the script
              // loads instead of being silently blocked. Plausible is
              // gated on NEXT_PUBLIC_PLAUSIBLE_DOMAIN at render time but
              // CSP needs the host pre-allowed so we don't have to flip
              // CSP at the same time the env var lands.
              "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://plausible.io",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
              `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:*"} https://fonts.googleapis.com https://fonts.gstatic.com https://cloudflareinsights.com https://plausible.io`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          // LOW-3 fix: X-XSS-Protection is ignored by modern browsers and
          // historically had reflection-XSS bugs of its own. Setting it
          // to 0 explicitly disables the legacy filter rather than
          // leaving it ambiguous.
          { key: "X-XSS-Protection", value: "0" },
        ],
      },
    ];
  },
};

// Wrap with Sentry last so it receives the fully-composed config from
// next-intl. withSentryConfig is a no-op for the runtime when SENTRY_*
// build env vars are missing — keeps dev/self-hosted builds working
// without forcing a Sentry account on the operator.
//
// Source maps are uploaded only when SENTRY_AUTH_TOKEN is set in CI;
// silent: true suppresses the "no token, skipping upload" warning so
// local builds stay clean.
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG ?? "yulalabs",
  project: process.env.SENTRY_PROJECT ?? "braavolabs-ui",
  silent: !process.env.CI,
  // Upload broader chunks (helps source-map resolution for code-split
  // route bundles) but do NOT serve maps publicly — Sentry receives
  // them, browsers do not.
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // Disable the Vercel-specific telemetry chatter that complains in
  // our standalone Docker output.
  disableLogger: true,
});
