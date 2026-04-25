import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://braavolabs.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  // Static, publicly indexable routes only. Authenticated surfaces
  // (dashboard, settings, billing, companies/*) live behind login and
  // are explicitly disallowed in robots.ts.
  const staticRoutes: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
    priority: number;
  }> = [
    { path: "/", changeFrequency: "weekly", priority: 1.0 },
    { path: "/pricing", changeFrequency: "weekly", priority: 0.9 },
    { path: "/features", changeFrequency: "weekly", priority: 0.8 },
    // /marketplace deliberately omitted — it requires login (useAuthGuard) and
    // returns a redirect. When the public-discoverable catalog ships
    // (separate PR), restore with priority 0.8 + changeFrequency: "daily".
    { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
    // /risks removed — auth-guarded (useAuthGuard redirects to /login),
    // would index as a redirect chain. Add back if a public risk-status
    // page ships separately.
    { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
    { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  ];

  return staticRoutes.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));
}
