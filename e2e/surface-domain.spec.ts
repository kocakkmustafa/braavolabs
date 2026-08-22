import { expect, test } from "@playwright/test";
import { POSTS } from "../packages/ui/app/blog/posts";
import { DOCS } from "../packages/ui/app/docs/content";

const WWW = { Host: "www.braavolabs.com", "X-Forwarded-Proto": "https" };
const APP = { Host: "app.braavolabs.com", "X-Forwarded-Proto": "https" };
const FORBIDDEN_RENDERED_CLAIMS = [
  /\bFree\b/i,
  /\bCreator\b/,
  /\bPro\b/,
  /\bBusiness\b/,
  /\bEnterprise\b/,
  /\b(?:start|try)(?: Braavolabs)? free\b/i,
  /\bno (?:credit )?card(?: needed|required)?\b/i,
  /\btrial\b/i,
  /\b(?:3|three|first three)\s+(?:free\s+|trial\s+)?runs?\b/i,
  /\$0\.30\b/,
  /\b(?:managed|system) inference\b/i,
  /\bhosted inference\b/i,
  /\bplatform-owned Groq(?: pool)?\b/i,
  /\b38\s*%/,
  /\bfully replayable\b/i,
  /\bfully[- ]audited\b/i,
  /\bfully offline\b/i,
  /\bon-device\b/i,
  /\b(?:zero|no) data egress\b/i,
  /\bzero token cost\b/i,
  /\b(?:offline|on-device|local)\s+Gemma\b|\bGemma\s+(?:inference|model)\b/i,
  /\bencrypted offline (?:export )?bundle\b/i,
  /\bmachine-bound (?:encrypted )?bundle\b/i,
  /\bair[ -]?gapped\b/i,
  /\b\d+\s+providers?\b/i,
  /\b(?:twelve|fourteen)\s+providers?\b/i,
  /\$39\/user\/month\b/,
  /\bKVKK \+ GDPR compliant\b/,
];

const STATIC_PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/security",
  "/docs",
  "/about",
  "/blog",
  "/contact",
  "/cookies",
  "/cost-calculator",
  "/changelog",
  "/compare",
  "/kvkk",
  "/privacy",
  "/terms",
  "/legal/account-deletion",
  "/status",
  "/support",
];

const EXPECTED_DOC_SLUGS = [
  "getting-started",
  "concepts",
  "byok-and-providers",
  "mid-run-steering",
  "webhooks",
  "external-automations",
  "mobile-app",
  "faq",
];

const EXPECTED_BLOG_SLUGS = [
  "steer-agents-mid-run",
  "five-risk-stops-explained",
  "byok-routing-without-lock-in",
  "pocket-steering",
  "local-model-routing-boundaries",
  "shipping-ask-user",
  "audit-trail-youd-actually-read",
];

const UNSUPPORTED_ROUTE_METADATA: Record<string, RegExp[]> = {
  "/cost-calculator": [
    /\bper-task (?:automation|metering)\b/i,
    /\bcompetitor(?: figures?)?\b/i,
    /\b(?:run volume|slide your)\b/i,
    /\bcost difference\b/i,
  ],
  "/status": [
    /\bpipeline worker\b/i,
    /\bwebhook delivery\b/i,
    /\bauthentication\b/i,
    /\bbilling\b/i,
    /\bincident (?:history|timeline)\b/i,
  ],
};

const PUBLIC_ROUTES = [
  ...STATIC_PUBLIC_ROUTES,
  ...DOCS.map(({ slug }) => `/docs/${slug}`),
  ...POSTS.map(({ slug }) => `/blog/${slug}`),
];

function canonicalForRoute(route: string): string {
  return route === "/" ? "https://www.braavolabs.com" : `https://www.braavolabs.com${route}`;
}

test("www renders public truth without tenant content, auth cookies, or unresolved keys", async ({ request }) => {
  const response = await request.get("/", { headers: WWW, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-braavolabs-surface"]).toBe("public");
  expect(response.headers()["set-cookie"] ?? "").not.toMatch(/bv_(?:access|refresh)_token/i);

  const body = await response.text();
  expect(body).toContain("Individual");
  expect(body).toContain("$19/month");
  expect(body).toContain("$39/active-user/month");
  expect(body).not.toMatch(/\bfeatures\.[a-zA-Z0-9_.-]+\b/);
  expect(body).not.toMatch(/data-tenant|dashboard API|CommandPalette/i);
});

test("production-rendered public HTML has zero forbidden claims", async ({ request }) => {
  expect(STATIC_PUBLIC_ROUTES).toHaveLength(18);
  expect(DOCS.map(({ slug }) => slug)).toEqual(EXPECTED_DOC_SLUGS);
  expect(POSTS.map(({ slug }) => slug)).toEqual(EXPECTED_BLOG_SLUGS);
  expect(PUBLIC_ROUTES).toHaveLength(33);

  const findings: string[] = [];
  for (const path of PUBLIC_ROUTES) {
    const response = await request.get(path, { headers: WWW, maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()["x-braavolabs-surface"], path).toBe("public");
    expect(response.headers()["set-cookie"] ?? "", path).not.toMatch(/bv_(?:access|refresh)_token/i);
    const body = await response.text();
    expect(body, `${path} contains an unresolved i18n key`).not.toMatch(/\bfeatures\.[a-zA-Z0-9_.-]+\b/);
    expect(body, `${path} contains a relative authenticated link`).not.toMatch(/href=["']\/(?:login|register|signup|dashboard|runs)\b/);
    for (const claim of FORBIDDEN_RENDERED_CLAIMS) {
      expect(body, `${path} contains ${claim}`).not.toMatch(claim);
    }

    const expectedCanonical = canonicalForRoute(path);
    const canonical = body.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
    const ogUrl = body.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1];
    if (canonical !== expectedCanonical) findings.push(`${path}: canonical ${canonical ?? "missing"}`);
    if (ogUrl !== expectedCanonical) findings.push(`${path}: og:url ${ogUrl ?? "missing"}`);
    const metadata = [
      body.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? "",
      body.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1] ?? "",
    ].join("\n");
    for (const pattern of UNSUPPORTED_ROUTE_METADATA[path] ?? []) {
      if (pattern.test(metadata)) findings.push(`${path}: unsupported metadata ${pattern}`);
    }
  }
  expect(findings, `public metadata drift:\n${findings.join("\n")}`).toEqual([]);
});

test("download and unpublished CLI routes fail closed without executable content", async ({ request }) => {
  const download = await request.get("/download", { headers: WWW, maxRedirects: 0 });
  expect(download.status()).toBe(308);
  expect(download.headers().location).toBe("https://www.braavolabs.com/docs/getting-started");

  const install = await request.get("/install", { headers: WWW, maxRedirects: 0 });
  expect(install.status()).toBe(503);
  expect(install.headers()["content-type"]).toMatch(/^text\/plain\b/);
  const body = await install.text();
  expect(body).toMatch(/not publicly available/i);
  expect(body).not.toMatch(/#!\/bin\/sh|npm install\s+-g/);
});

test("machine-readable public claims use the same frozen contract", async ({ request }) => {
  const response = await request.get("/", { headers: WWW, maxRedirects: 0 });
  const body = await response.text();
  const jsonLd = [...body.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n");

  for (const claim of FORBIDDEN_RENDERED_CLAIMS) {
    expect(jsonLd, `public JSON-LD contains ${claim}`).not.toMatch(claim);
  }
  expect(jsonLd).toContain("Individual — $19/month");
  expect(jsonLd).toContain("Team — $39/active-user/month");
  expect(jsonLd).toContain("Inference is not included");
});

test("captures the corrected public home for review evidence", async ({ page, request }) => {
  const response = await request.get("/", { headers: WWW, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const html = (await response.text())
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(
      "<head>",
      '<head><style>body{margin:0;background:#06070a;color:#e8ebf0;font-family:system-ui,sans-serif}a{color:inherit}.bv-glass{border:1px solid #3a4150;border-radius:16px}.text-on-surface-variant{color:#9aa3b2}</style>',
    );
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Individual — $19/month" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Team — $39/active-user/month" })).toBeVisible();
  await page.screenshot({ path: "test-results/br-p0-000-public-home-after.png", fullPage: true });
});

test("www redirects an authenticated route with 308 before tenant render", async ({ request }) => {
  const response = await request.get("/dashboard?from=public", { headers: WWW, maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("https://app.braavolabs.com/dashboard?from=public");
  expect(response.headers()["set-cookie"] ?? "").not.toMatch(/bv_(?:access|refresh)_token/i);

  const body = await response.text();
  expect(body).not.toMatch(/data-tenant|command center|workspace selector|<main|<html/i);
});

test("app redirects public marketing routes to www and retains app-only routes", async ({ request }) => {
  const pricing = await request.get("/pricing", { headers: APP, maxRedirects: 0 });
  expect(pricing.status()).toBe(308);
  expect(pricing.headers().location).toBe("https://www.braavolabs.com/pricing");

  const login = await request.get("/login", { headers: APP, maxRedirects: 0 });
  expect(login.status()).toBe(200);
  expect(login.headers()["x-braavolabs-surface"]).toBe("authenticated");
});

test("apex resolves canonically before either product surface renders", async ({ request }) => {
  const publicResponse = await request.get("/security", {
    headers: { Host: "braavolabs.com", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(publicResponse.status()).toBe(308);
  expect(publicResponse.headers().location).toBe("https://www.braavolabs.com/security");

  const appResponse = await request.get("/companies", {
    headers: { Host: "braavolabs.com", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(appResponse.status()).toBe(308);
  expect(appResponse.headers().location).toBe("https://app.braavolabs.com/companies");
});

test("unrecognized production hosts fail closed before rendering", async ({ request }) => {
  const publicResponse = await request.get("/docs", {
    headers: { Host: "preview.example", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(publicResponse.status()).toBe(308);
  expect(publicResponse.headers().location).toBe("https://www.braavolabs.com/docs");

  const tenantResponse = await request.get("/companies", {
    headers: { Host: "preview.example", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(tenantResponse.status()).toBe(308);
  expect(tenantResponse.headers().location).toBe("https://app.braavolabs.com/companies");
  expect(await tenantResponse.text()).not.toMatch(/<main|<html|data-tenant/i);
});
