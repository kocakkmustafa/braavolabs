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
    { path: "/about", changeFrequency: "monthly", priority: 0.6 },
    { path: "/contact", changeFrequency: "monthly", priority: 0.6 },
    { path: "/blog", changeFrequency: "weekly", priority: 0.5 },
    { path: "/changelog", changeFrequency: "weekly", priority: 0.4 },
    { path: "/status", changeFrequency: "daily", priority: 0.4 },
    // /risks removed — auth-guarded (useAuthGuard redirects to /login),
    // would index as a redirect chain. Add back if a public risk-status
    // page ships separately.
    { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
    { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
    { path: "/cookies", changeFrequency: "yearly", priority: 0.3 },
    { path: "/kvkk", changeFrequency: "yearly", priority: 0.3 },
    { path: "/gdpr", changeFrequency: "yearly", priority: 0.3 },
  ];

  return staticRoutes.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));
}
