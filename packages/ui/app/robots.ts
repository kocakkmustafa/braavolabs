import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://braavolabs.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dashboard",
          "/dashboard/",
          "/settings",
          "/settings/",
          "/billing",
          "/billing/",
          "/companies/",
          "/login",
          "/register",
          "/reset-password",
          "/auth/",
          "/onboarding",
          "/approvals",
          "/drafts",
          "/runs/",
          "/pipelines/",
          "/integrations/",
          "/webhooks",
          "/ab-tests",
          "/analytics",
          "/errors",
          "/risks",
          "/companies",
          "/connections",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
