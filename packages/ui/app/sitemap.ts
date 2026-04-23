import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://braavoo.com";

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
    { path: "/marketplace", changeFrequency: "daily", priority: 0.8 },
    { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
    { path: "/risks", changeFrequency: "monthly", priority: 0.5 },
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
