import type { NextConfig } from "next";
import path from "path";

// Monorepo root (two levels up from packages/ui)
const MONOREPO_ROOT = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-company-os/core"],
  productionBrowserSourceMaps: false,
  // Setting turbopack.root to the monorepo root matches what Next.js
  // auto-detects, suppressing the secondary-lockfile scan that otherwise
  // picks up git worktrees and tries to compile them.
  turbopack: {
    root: MONOREPO_ROOT,
  },
  webpack(config) {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [/node_modules/, /\.git/, /\.claude[\\/]worktrees/],
    };
    return config;
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
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https:",
              `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:*"} https://*.googleapis.com`,
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
