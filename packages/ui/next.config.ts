import type { NextConfig } from "next";
import path from "path";

// Monorepo root (two levels up from packages/ui)
const MONOREPO_ROOT = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-company-os/core"],
  productionBrowserSourceMaps: false,
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
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https:",
              `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:*"} https://fonts.googleapis.com https://fonts.gstatic.com`,
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

export default nextConfig;
