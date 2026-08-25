import net from "node:net";
import { expect, test, type APIResponse } from "@playwright/test";
import { POSTS } from "../packages/ui/app/blog/posts";
import { DOCS } from "../packages/ui/app/docs/content";
import { classifySurfacePath } from "../packages/ui/lib/surface-domain";

const WWW = { Host: "www.braavolabs.com", "X-Forwarded-Proto": "https" };
const APP = { Host: "app.braavolabs.com", "X-Forwarded-Proto": "https" };
const LOCALES = ["ar", "de", "en", "es", "fr", "tr"] as const;
const EXPECTED_PRICING_DESCRIPTION =
  "Planned pricing preview: Individual $19/month and Team $39/active-user/month. Not currently purchasable; inference is not included.";
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
  /\bend[ -]to[ -]end encrypt(?:ed|ion)\b/i,
  /\b(?:Braavolabs )?cloud cannot read (?:the )?plaintext\b/i,
  /\bcloud[ -]blind(?:ness)?\b/i,
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
  "/gdpr",
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

async function expectStrict421(response: APIResponse, label: string) {
  expect(response.status(), label).toBe(421);
  expect(response.headers()["set-cookie"] ?? "", `${label} auth cookie`).not.toMatch(/bv_(?:access|refresh)_token/i);
  expect(response.headers()["access-control-allow-origin"] ?? "", `${label} CORS`).toBe("");
  expect(await response.text(), `${label} tenant body`).not.toMatch(
    /data-tenant|command center|workspace selector|<main|<html/i,
  );
}

function rawHttp10WithoutHost(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy(new Error("raw HTTP/1.0 request timed out")));
    socket.on("connect", () => socket.end(`GET ${path} HTTP/1.0\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
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
  expect(body).toContain("Private Mode — preview");
  expect(body).toContain("Cloud Agent Mode — in development");
  expect(body).toContain("Pricing preview — not currently purchasable");
  expect(body).not.toMatch(/\bfeatures\.[a-zA-Z0-9_.-]+\b/);
  expect(body).not.toMatch(/data-tenant|dashboard API|CommandPalette/i);
});

test("shared logo is available logged out on both product hosts", async ({ request }) => {
  expect(classifySurfacePath("/braavolabs-logo.png")).toBe("shared");

  for (const { headers, hostSurface } of [
    { headers: WWW, hostSurface: "public" },
    { headers: APP, hostSurface: "authenticated" },
  ] as const) {
    const response = await request.get("/braavolabs-logo.png", { headers, maxRedirects: 0 });
    expect(response.status(), headers.Host).toBe(200);
    expect(response.headers()["x-braavolabs-surface"], headers.Host).toBe(hostSurface);
    expect(response.headers()["content-type"], headers.Host).toMatch(/^image\/png\b/);
    expect(response.headers()["set-cookie"] ?? "", headers.Host).not.toMatch(/bv_(?:access|refresh)_token/i);
  }
});

test("all public locale namespaces render without raw translation output", async ({ request }) => {
  for (const locale of LOCALES) {
    for (const path of PUBLIC_ROUTES) {
      const response = await request.get(path, {
        headers: { ...WWW, Cookie: `NEXT_LOCALE=${locale}` },
        maxRedirects: 0,
      });
      expect(response.status(), `${locale} ${path}`).toBe(200);
      const body = await response.text();
      expect(body, `${locale} ${path} raw key`).not.toMatch(/\b(?:static|features)\.[a-zA-Z0-9_.-]+\b/);
      expect(body, `${locale} ${path} translation error`).not.toMatch(/MISSING_MESSAGE|IntlError|Could not resolve|translation error/i);
    }
  }
});

test("production-rendered public HTML has zero forbidden claims", async ({ request }) => {
  expect(STATIC_PUBLIC_ROUTES).toHaveLength(19);
  expect(DOCS.map(({ slug }) => slug)).toEqual(EXPECTED_DOC_SLUGS);
  expect(POSTS.map(({ slug }) => slug)).toEqual(EXPECTED_BLOG_SLUGS);
  expect(PUBLIC_ROUTES).toHaveLength(34);

  const findings: string[] = [];
  for (const path of PUBLIC_ROUTES) {
    const response = await request.get(path, { headers: WWW, maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()["x-braavolabs-surface"], path).toBe("public");
    expect(response.headers()["set-cookie"] ?? "", path).not.toMatch(/bv_(?:access|refresh)_token/i);
    const body = await response.text();
    expect(body, `${path} contains an unresolved i18n key`).not.toMatch(/\b(?:static|features)\.[a-zA-Z0-9_.-]+\b/);
    expect(body, `${path} contains a relative authenticated link`).not.toMatch(/href=["']\/(?:login|register|signup|dashboard|runs)\b/);
    for (const claim of FORBIDDEN_RENDERED_CLAIMS) {
      expect(body, `${path} contains ${claim}`).not.toMatch(claim);
    }

    const expectedCanonical = canonicalForRoute(path);
    const canonical = body.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
    const ogUrl = body.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1];
    if (canonical !== expectedCanonical) findings.push(`${path}: canonical ${canonical ?? "missing"}`);
    if (ogUrl !== expectedCanonical) findings.push(`${path}: og:url ${ogUrl ?? "missing"}`);
    const description = body.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? "";
    const ogDescription = body.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1] ?? "";
    const twitterDescription = body.match(/<meta\s+name="twitter:description"\s+content="([^"]*)"/i)?.[1] ?? "";
    const metadata = [description, ogDescription, twitterDescription].join("\n");
    if (path === "/pricing") {
      expect(description).toBe(EXPECTED_PRICING_DESCRIPTION);
      expect(ogDescription).toBe(EXPECTED_PRICING_DESCRIPTION);
      expect(twitterDescription).toBe(EXPECTED_PRICING_DESCRIPTION);
    }
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
  const jsonBlocks = [...body.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .map((match) => JSON.parse(match[1]) as { "@graph"?: Array<Record<string, unknown>> });
  const jsonLd = JSON.stringify(jsonBlocks);
  const software = jsonBlocks
    .flatMap((block) => block["@graph"] ?? [])
    .find((entry) => entry["@type"] === "SoftwareApplication");

  for (const claim of FORBIDDEN_RENDERED_CLAIMS) {
    expect(jsonLd, `public JSON-LD contains ${claim}`).not.toMatch(claim);
  }
  expect(software).toBeDefined();
  expect(software?.featureList).toEqual([
    "Pricing preview — not currently purchasable",
    "Planned pricing: Individual $19/month; Team $39/active-user/month; not currently purchasable",
    "Private Mode — preview; its complete data-handling and security contract remains in development.",
    "Cloud Agent Mode — in development; its execution, consent, and retention contract is not presented as generally available.",
    "Holding — premium/private preview",
    "Signed evidence — in development",
  ]);
  expect(body).toContain("Individual — $19/month");
  expect(body).toContain("Team — $39/active-user/month");
  expect(jsonLd).toContain("Inference is not included");
  expect(jsonLd).toContain("Private Mode — preview");
  expect(jsonLd).toContain("Cloud Agent Mode — in development");
  expect(jsonLd).toContain("Pricing preview — not currently purchasable");
  expect(jsonLd).not.toContain('"@type":"Offer"');
  expect(body).toContain("Pricing preview — not currently purchasable");
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

const ALIAS_CASES = [
  { path: "/destek?lang=tr", location: "https://www.braavolabs.com/support?lang=tr" },
  { path: "/legal/privacy", location: "https://www.braavolabs.com/privacy" },
  { path: "/legal/terms", location: "https://www.braavolabs.com/terms" },
] as const;

for (const host of [WWW.Host, APP.Host, "braavolabs.com"]) {
  for (const { path, location } of ALIAS_CASES) {
    test(`canonical alias ${path} on ${host}`, async ({ request }) => {
      const response = await request.get(path, { headers: { Host: host }, maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe(location);
      expect(response.headers()["set-cookie"] ?? "").not.toMatch(/bv_(?:access|refresh)_token/i);
    });
  }
}

for (const path of ["/forge", "/forge-home", "/forge/runs", "/forge-home/runs"]) {
  test(`www keeps ${path} on the authenticated surface`, async ({ request }) => {
    const response = await request.get(path, { headers: WWW, maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(`https://app.braavolabs.com${path}`);
  });

  test(`app does not collapse ${path} to the marketing root`, async ({ request }) => {
    const response = await request.get(path, { headers: APP, maxRedirects: 0 });
    expect(response.status()).not.toBe(308);
    expect(response.headers()["x-braavolabs-surface"]).toBe("authenticated");
  });
}

const STRICT_HOSTS = [
  { label: "empty", host: "" },
  { label: "malicious suffix", host: "www.braavolabs.com.evil.test" },
  { label: "userinfo", host: "user@www.braavolabs.com" },
  { label: "comma spoof", host: "www.braavolabs.com,app.braavolabs.com" },
  { label: "multiple trailing dots", host: "www.braavolabs.com.." },
  { label: "port overflow", host: "www.braavolabs.com:65536" },
  { label: "unknown", host: "preview.example" },
  { label: "localhost", host: "localhost:3000" },
  { label: "IPv4 localhost", host: "127.0.0.1:3000" },
  { label: "IPv6 localhost", host: "[::1]:3000" },
] as const;

for (const { label, host } of STRICT_HOSTS) {
  for (const path of ["/dashboard", "/destek", "/download"]) {
    test(`strict 421 for ${label} Host on ${path}`, async ({ request }) => {
      const response = await request.get(path, { headers: { Host: host }, maxRedirects: 0 });
      await expectStrict421(response, `${label} ${path}`);
    });
  }
}

for (const path of ["/dashboard", "/destek", "/download"]) {
  test(`raw HTTP/1.0 missing Host returns strict 421 on ${path}`, async ({ baseURL }) => {
    const port = Number(new URL(baseURL ?? "http://127.0.0.1:31079").port);
    const raw = await rawHttp10WithoutHost(port, path);
    expect(raw.split("\r\n", 1)[0]).toMatch(/^HTTP\/1\.[01] 421\b/);
    expect(raw).not.toMatch(/\r\nset-cookie:/i);
    expect(raw).not.toMatch(/\r\naccess-control-allow-origin:/i);
    expect(raw).not.toMatch(/data-tenant|command center|workspace selector|<main|<html/i);
  });
}

for (const forwardedHost of ["app.braavolabs.com", "www.braavolabs.com.evil.test", "user@app.braavolabs.com"]) {
  test(`forwarded-host spoof ${forwardedHost} fails closed`, async ({ request }) => {
    const response = await request.get("/dashboard", {
      headers: { Host: "www.braavolabs.com", "X-Forwarded-Host": forwardedHost },
      maxRedirects: 0,
    });
    await expectStrict421(response, forwardedHost);
  });
}

for (const host of ["WWW.BRAAVOLABS.COM:443", "www.braavolabs.com."]) {
  test(`canonical Host variant ${host} remains valid`, async ({ request }) => {
    const response = await request.get("/dashboard", { headers: { Host: host }, maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe("https://app.braavolabs.com/dashboard");
  });
}

test("matching forwarded Host cannot change the authoritative origin", async ({ request }) => {
  const response = await request.get("/dashboard", {
    headers: { Host: "www.braavolabs.com", "X-Forwarded-Host": "WWW.BRAAVOLABS.COM:443" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("https://app.braavolabs.com/dashboard");
});

for (const path of ["/download/?source=nav", "/download/desktop?source=nav"]) {
  test(`download ${path} is a single canonical redirect`, async ({ request }) => {
    const response = await request.get(path, { headers: WWW, maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe("https://www.braavolabs.com/docs/getting-started?source=nav");
  });
}

for (const path of ["/install", "/install/", "/install/cli", "/install.sh"]) {
  test(`installer ${path} is directly fail-closed on www`, async ({ request }) => {
    const response = await request.get(path, { headers: WWW, maxRedirects: 0 });
    expect(response.status()).toBe(503);
    expect(await response.text()).not.toMatch(/#!\/bin\/sh|npm install\s+-g/);
  });
}

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
  expect(publicResponse.status()).toBe(421);
  expect(await publicResponse.text()).not.toMatch(/<main|<html|data-tenant/i);

  const tenantResponse = await request.get("/companies", {
    headers: { Host: "preview.example", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(tenantResponse.status()).toBe(421);
  expect(await tenantResponse.text()).not.toMatch(/<main|<html|data-tenant/i);
});
