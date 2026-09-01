import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["ar", "de", "en", "es", "fr", "tr"];

const ALLOWED_PUBLIC_SOURCE_PATHS = [
  "packages/ui/app/layout.tsx",
  "packages/ui/app/page.tsx",
  "packages/ui/app/pricing/page.tsx",
  "packages/ui/app/features/page.tsx",
  "packages/ui/app/docs/content.ts",
  "packages/ui/app/security/page.tsx",
];

// Keep this corpus broader than the write scope. A test that only inspects files
// the task may edit could claim GREEN while another reachable public route still
// publishes retired pricing, auth links, or unsupported delivery promises.
const PUBLIC_CORPUS_PATHS = [
  ...ALLOWED_PUBLIC_SOURCE_PATHS,
  "packages/ui/app/about/page.tsx",
  "packages/ui/app/blog/[slug]/page.tsx",
  "packages/ui/app/blog/page.tsx",
  "packages/ui/app/blog/posts.ts",
  "packages/ui/app/changelog/page.tsx",
  "packages/ui/app/compare/page.tsx",
  "packages/ui/app/contact/page.tsx",
  "packages/ui/app/cookies/page.tsx",
  "packages/ui/app/cost-calculator/page.tsx",
  "packages/ui/app/docs/[slug]/page.tsx",
  "packages/ui/app/docs/page.tsx",
  "packages/ui/app/gdpr/page.tsx",
  "packages/ui/app/kvkk/page.tsx",
  "packages/ui/app/legal/account-deletion/page.tsx",
  "packages/ui/app/privacy/page.tsx",
  "packages/ui/app/status/page.tsx",
  "packages/ui/app/support/page.tsx",
  "packages/ui/app/terms/page.tsx",
  "packages/ui/messages/ar.json",
  "packages/ui/messages/de.json",
  "packages/ui/messages/en.json",
  "packages/ui/messages/es.json",
  "packages/ui/messages/fr.json",
  "packages/ui/messages/tr.json",
];

// Next.js merges route layouts after the root metadata function. Keep this
// corpus separate from visible copy so a nested apex canonical cannot silently
// override an otherwise-correct www root contract.
const PUBLIC_METADATA_LAYOUT_PATHS = [
  "packages/ui/app/about/layout.tsx",
  "packages/ui/app/blog/layout.tsx",
  "packages/ui/app/changelog/layout.tsx",
  "packages/ui/app/contact/layout.tsx",
  "packages/ui/app/cookies/layout.tsx",
  "packages/ui/app/cost-calculator/layout.tsx",
  "packages/ui/app/features/layout.tsx",
  "packages/ui/app/gdpr/layout.tsx",
  "packages/ui/app/kvkk/layout.tsx",
  "packages/ui/app/legal/account-deletion/layout.tsx",
  "packages/ui/app/pricing/layout.tsx",
  "packages/ui/app/privacy/layout.tsx",
  "packages/ui/app/status/layout.tsx",
  "packages/ui/app/terms/layout.tsx",
];

const APPROVED_TRUTH = [
  "Individual — $19/month",
  "Team — $39/active-user/month",
  "Inference is not included",
  "Private Mode — preview",
  "Cloud Agent Mode — in development",
  "Holding — premium/private preview",
  "Signed evidence — in development",
  "cross-vendor AI workbench and control plane",
];

const FORBIDDEN_PUBLIC_CLAIMS = [
  ["retired Free plan", /\bFree (?:plan|tier|forever)\b|\bfree tier\b/gi],
  ["retired Creator plan", /\bCreator\b/g],
  ["retired Pro plan", /\bPro\b/g],
  ["retired Business plan", /\bBusiness (?:plan|tier)\b|\bChoose Business\b/g],
  ["retired Enterprise plan", /\bEnterprise\b/g],
  ["retired free CTA", /\b(?:Start|Try)(?: Braavolabs)? free\b/gi],
  ["retired no-card CTA", /\bno (?:credit )?card(?: needed|required)?\b/gi],
  ["trial claim", /\btrial\b/gi],
  ["platform-funded inference", /\bplatform-owned Groq(?: pool)?\b/gi],
  ["retired four-tier catalog", /\bflat tiers?\s*[—-]\s*free\b/gi],
  ["unsupported saving", /\b38\s*%/g],
  ["fully replayable", /\bfully replayable\b/gi],
  ["fully offline", /\bfully offline\b/gi],
  ["on-device model", /\bon-device\b/gi],
  ["air-gapped", /\bair[ -]?gapped\b/gi],
  ["unverified provider count", /\b(?:12|14|twelve|fourteen)\s+providers?\b/gi],
  ["retired per-user price", /\$39\/user\/month\b/gi],
  ["unsupported end-to-end encryption guarantee", /\bend[ -]to[ -]end encrypt(?:ed|ion)\b/gi],
  ["unsupported cloud plaintext guarantee", /\b(?:Braavolabs )?cloud cannot read (?:the )?plaintext\b/gi],
  ["unsupported cloud-blindness guarantee", /\bcloud[ -]blind(?:ness)?\b/gi],
];

const UNSUPPORTED_METADATA_SOURCE_PATTERNS = new Map([
  [
    "packages/ui/app/cost-calculator/layout.tsx",
    [
      /\bper-task (?:automation|metering)\b/i,
      /\bcompetitor(?: figures?)?\b/i,
      /\b(?:run volume|slide your)\b/i,
      /\bcost difference\b/i,
    ],
  ],
  [
    "packages/ui/app/status/layout.tsx",
    [
      /\bpipeline worker\b/i,
      /\bwebhook delivery\b/i,
      /\bauthentication\b/i,
      /\bbilling\b/i,
      /\bincident (?:history|timeline)\b/i,
    ],
  ],
]);

function read(path) {
  const absolute = join(ROOT, path);
  assert.ok(existsSync(absolute), `${path} must exist`);
  return readFileSync(absolute, "utf8");
}

function bundle(paths) {
  return paths.map((path) => `\n/* ${path} */\n${read(path)}`).join("\n");
}

function claimViolations(source) {
  return FORBIDDEN_PUBLIC_CLAIMS.flatMap(([label, pattern]) => {
    pattern.lastIndex = 0;
    const matches = [...source.matchAll(pattern)];
    return matches.map((match) => `${label}: ${JSON.stringify(match[0])}`);
  });
}

test("authorized public sources expose only the frozen contract", () => {
  const source = bundle(ALLOWED_PUBLIC_SOURCE_PATHS);

  for (const sentence of APPROVED_TRUTH) {
    assert.ok(source.includes(sentence), `missing canonical truth: ${sentence}`);
  }

  const violations = claimViolations(source);
  assert.deepEqual(violations, [], `forbidden claims remain in authorized sources:\n${violations.join("\n")}`);

  const layout = read("packages/ui/app/layout.tsx");
  assert.doesNotMatch(layout, /name:\s*"(?:Free|Creator|Pro|Business|Enterprise)"/);
  assert.doesNotMatch(layout, /"@type":\s*"Offer"/);
  assert.match(layout, /Planned pricing: Individual \$19\/month; Team \$39\/active-user\/month; not currently purchasable/);
});

test("source and structured-data source cannot publish unsupported shipped security guarantees", () => {
  const source = bundle(ALLOWED_PUBLIC_SOURCE_PATHS);
  assert.match(source, /Private Mode — preview/);
  assert.match(source, /Cloud Agent Mode — in development/);
  assert.match(source, /Exact-action approval — in development/);
  assert.doesNotMatch(source, /broader exact-action binding is part of the governed control contract/i);
  assert.doesNotMatch(source, /\bend[ -]to[ -]end encrypt(?:ed|ion)\b/i);
  assert.doesNotMatch(source, /\b(?:Braavolabs )?cloud cannot read (?:the )?plaintext\b/i);
  assert.doesNotMatch(source, /\bcloud[ -]blind(?:ness)?\b/i);

  const layout = read("packages/ui/app/layout.tsx");
  assert.match(layout, /featureList/);
  assert.match(layout, /Private Mode — preview/);
  assert.match(layout, /Cloud Agent Mode — in development/);
});

test("planned pricing cannot be presented as currently purchasable", () => {
  const source = bundle(ALLOWED_PUBLIC_SOURCE_PATHS);
  const layout = read("packages/ui/app/layout.tsx");
  const pricingPage = read("packages/ui/app/pricing/page.tsx");
  const pricingLayout = read("packages/ui/app/pricing/layout.tsx");
  assert.match(source, /Pricing preview — not currently purchasable/);
  assert.match(source, /Individual — \$19\/month/);
  assert.match(source, /Team — \$39\/active-user\/month/);
  assert.doesNotMatch(source, /\bChoose (?:Individual|Team)\b/);
  assert.doesNotMatch(source, /Public pricing contract/);
  assert.doesNotMatch(layout, /"@type":\s*"Offer"/);
  assert.match(layout, /Planned pricing: Individual \$19\/month; Team \$39\/active-user\/month; not currently purchasable/);

  for (const [path, metadata] of [
    ["packages/ui/app/pricing/page.tsx", pricingPage],
    ["packages/ui/app/pricing/layout.tsx", pricingLayout],
  ]) {
    assert.match(metadata, /Planned pricing preview:/, `${path}: metadata maturity missing`);
    assert.match(metadata, /not currently purchasable/i, `${path}: purchase state missing`);
    assert.match(metadata, /inference is not included/i, `${path}: inference exclusion missing`);
    assert.doesNotMatch(metadata, /Braavolabs Individual and Team subscription pricing\./, `${path}: current-sale metadata remains`);
  }
});

test("complete reachable public source corpus has zero retired claims", () => {
  assert.equal(new Set(PUBLIC_CORPUS_PATHS).size, PUBLIC_CORPUS_PATHS.length, "public corpus contains duplicate paths");
  assert.equal(PUBLIC_CORPUS_PATHS.length, 30, "public corpus sentinel changed without review");

  const violations = [];
  for (const path of PUBLIC_CORPUS_PATHS) {
    for (const violation of claimViolations(read(path))) {
      violations.push(`${path}: ${violation}`);
    }
  }

  assert.deepEqual(violations, [], `retired claims remain reachable:\n${violations.join("\n")}`);
});

test("machine-readable public source corpus is www-only and the unpublished installer is inert", () => {
  assert.equal(
    new Set(PUBLIC_METADATA_LAYOUT_PATHS).size,
    PUBLIC_METADATA_LAYOUT_PATHS.length,
    "metadata corpus contains duplicate paths",
  );
  assert.equal(PUBLIC_METADATA_LAYOUT_PATHS.length, 14, "metadata layout sentinel changed without review");

  const violations = [];
  for (const path of PUBLIC_METADATA_LAYOUT_PATHS) {
    const source = read(path);
    if (/https:\/\/braavolabs\.com\b/.test(source)) violations.push(`${path}: apex metadata remains`);
    if (!/https:\/\/www\.braavolabs\.com/.test(source)) violations.push(`${path}: www metadata missing`);
    for (const claim of claimViolations(source)) violations.push(`${path}: ${claim}`);
    for (const pattern of UNSUPPORTED_METADATA_SOURCE_PATTERNS.get(path) ?? []) {
      if (pattern.test(source)) violations.push(`${path}: unsupported metadata ${pattern}`);
    }
  }

  for (const path of ["packages/ui/app/robots.ts", "packages/ui/app/sitemap.ts"]) {
    const source = read(path);
    if (/https:\/\/braavolabs\.com\b/.test(source)) violations.push(`${path}: apex machine URL remains`);
    if (!/https:\/\/www\.braavolabs\.com/.test(source)) violations.push(`${path}: www machine URL missing`);
  }

  const installer = read("packages/ui/app/install/route.ts");
  if (/#!\/bin\/sh|npm install\s+-g|application\/x-sh/i.test(installer)) {
    violations.push("packages/ui/app/install/route.ts: executable installer source remains");
  }
  if (!/(?:status:\s*503|NextResponse\.redirect)/.test(installer)) {
    violations.push("packages/ui/app/install/route.ts: inert response contract missing");
  }

  assert.deepEqual(violations, [], `machine-readable/source drift remains:\n${violations.join("\n")}`);
});

test("features copy cannot render unresolved i18n keys", () => {
  const features = read("packages/ui/app/features/page.tsx");
  assert.doesNotMatch(features, /useTranslations|\bt\s*\(/, "features page still depends on runtime translation lookup");
  assert.doesNotMatch(features, /\bfeatures\.[a-zA-Z0-9_.-]+\b/, "unresolved features.* key remains in source");
});

test("public message pruning retains every namespace used by about and changelog in all locales", () => {
  const layout = read("packages/ui/app/layout.tsx");
  assert.match(layout, /selected\.about\s*=\s*staticMessages\.about/);
  assert.match(layout, /selected\.changelog\s*=\s*staticMessages\.changelog/);

  const informationalLabels = {
    ar: ["معاينة التسعير", "ضوابط إضافية — قيد التطوير"],
    de: ["Preisvorschau", "Zusätzliche Kontrollen — in Entwicklung"],
    en: ["Pricing preview", "Additional controls — in development"],
    es: ["Vista previa de precios", "Controles adicionales — en desarrollo"],
    fr: ["Aperçu des tarifs", "Contrôles supplémentaires — en développement"],
    tr: ["Fiyatlandırma önizlemesi", "Ek kontroller — geliştirme aşamasında"],
  };

  for (const locale of LOCALES) {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    assert.ok(messages.static?.common, `${locale}: static.common missing`);
    assert.ok(messages.static?.about, `${locale}: static.about missing`);
    assert.ok(messages.static?.changelog, `${locale}: static.changelog missing`);
    assert.equal(messages.app?.billing?.planCreatorName, "Individual", `${locale}: billing Individual drift`);
    assert.equal(messages.app?.billing?.planProName, "Team", `${locale}: billing Team drift`);
    assert.equal(messages.pricing?.plans?.creator?.name, "Individual", `${locale}: pricing Individual drift`);
    assert.equal(messages.pricing?.plans?.pro?.name, "Team", `${locale}: pricing Team drift`);
    assert.equal(messages.pricing?.plans?.free?.name, informationalLabels[locale][0], `${locale}: legacy entry plan remains`);
    assert.equal(
      messages.pricing?.plans?.business?.name,
      informationalLabels[locale][1],
      `${locale}: legacy organization plan remains`,
    );
  }
});

test("surface routing denies www authentication before tenant render", () => {
  const surface = read("packages/ui/lib/surface-domain.ts");
  const middleware = read("packages/ui/middleware.ts");

  assert.match(surface, /www\.braavolabs\.com/);
  assert.match(surface, /app\.braavolabs\.com/);
  assert.match(surface, /export function (?:classifySurfacePath|getSurfaceRedirect)/);
  assert.match(surface, /["']\/destek["']/);
  assert.match(surface, /["']\/legal\/privacy["']/);
  assert.match(surface, /["']\/legal\/terms["']/);
  assert.match(surface, /["']\/forge["']/);
  assert.match(surface, /["']\/forge-home["']/);
  assert.match(surface, /host\.includes\(["']@["']\)|candidate\.includes\(["']@["']\)/);
  assert.match(surface, /host\.includes\(["'],["']\)|candidate\.includes\(["'],["']\)/);
  assert.match(middleware, /status:\s*421/);
  assert.match(middleware, /x-forwarded-host/i, "Host and forwarded-host disagreement must fail closed");
  assert.match(middleware, /NextResponse\.redirect\([^\n]+308\)/, "wrong-surface redirect must be a canonical 308");
  assert.match(middleware, /x-braavolabs-surface/);
  assert.doesNotMatch(middleware, /request\.cookies\.set|response\.cookies\.set/);

  const publicSource = bundle(ALLOWED_PUBLIC_SOURCE_PATHS);
  assert.doesNotMatch(publicSource, /href\s*=\s*["']\/(?:login|register|signup|dashboard|runs)\b/);
  assert.match(publicSource, /https:\/\/app\.braavolabs\.com\/login/);
  assert.match(publicSource, /https:\/\/app\.braavolabs\.com\/register/);
});

test("production API origin matches the authenticated CSP contract", () => {
  const deploy = read(".github/workflows/deploy.yml");
  const middleware = read("packages/ui/middleware.ts");

  assert.match(deploy, /NEXT_PUBLIC_API_URL=https:\/\/api\.braavolabs\.com\/api\/v1/);
  assert.doesNotMatch(deploy, /NEXT_PUBLIC_API_URL=https:\/\/braavolabs\.com\/api\/v1/);
  assert.match(
    middleware,
    /connect-src[^\n]*https:\/\/api\.braavolabs\.com[^\n]*wss:\/\/api\.braavolabs\.com/,
  );
});

test("shared logo is an explicit exact surface asset", () => {
  const surface = read("packages/ui/lib/surface-domain.ts");
  assert.match(surface, /SHARED_EXACT_PATHS[^;]*["']\/braavolabs-logo\.png["']/s);
});

test("next config delegates canonical routing to fail-closed middleware", () => {
  const nextConfig = read("packages/ui/next.config.ts");
  const playwright = read("playwright.config.ts");

  assert.match(nextConfig, /skipTrailingSlashRedirect:\s*true/);
  assert.doesNotMatch(nextConfig, /async\s+redirects\s*\(/, "Next redirects must not preempt Host validation");
  for (const route of ["/destek", "/legal/privacy", "/legal/terms", "/forge", "/forge-home"]) {
    assert.ok(!nextConfig.includes(route), `next.config.ts duplicates middleware route ${route}`);
  }
  assert.match(playwright, /node packages\/ui\/\.next\/standalone\/packages\/ui\/server\.js/);
  assert.doesNotMatch(playwright, /\bnext start\b|@ai-company-os\/ui start/);
});

test("public legal and deletion copy exposes only canonical evidenced channels", () => {
  const legalPaths = [
    "packages/ui/app/contact/page.tsx",
    "packages/ui/app/cookies/page.tsx",
    "packages/ui/app/gdpr/page.tsx",
    "packages/ui/app/kvkk/page.tsx",
    "packages/ui/app/legal/account-deletion/page.tsx",
    "packages/ui/app/privacy/page.tsx",
    "packages/ui/app/support/page.tsx",
  ];
  const legalSource = bundle(legalPaths);
  const deletion = read("packages/ui/app/legal/account-deletion/page.tsx");
  const gdpr = read("packages/ui/app/gdpr/page.tsx");

  assert.doesNotMatch(legalSource, /href\s*=\s*["']\/account-deletion["']/);
  assert.match(legalSource, /href\s*=\s*["']\/legal\/account-deletion["']/);
  assert.match(deletion, /mailto:privacy@braavolabs\.com/);
  assert.doesNotMatch(deletion, /Settings\s*→\s*(?:Privacy\s*→\s*)?Delete account/i);
  assert.doesNotMatch(deletion, /\/contact\?topic=delete/);
  assert.doesNotMatch(deletion, /hot replica|90 days|synchronous|cascade completes|completes in seconds/i);
  assert.match(gdpr, /TLS 1\.2 and TLS 1\.3/);
  assert.doesNotMatch(gdpr, /AES-256 at rest|role-based access control|regular security reviews|kept for 12 months/i);

  for (const locale of LOCALES) {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    const sections = messages.static?.legal?.privacy?.sections;
    assert.ok(Array.isArray(sections), `${locale} privacy sections must remain an array`);
    const security = sections.find((section) => /TLS 1\.2/.test(section?.body ?? ""))?.body ?? "";
    assert.match(security, /TLS 1\.2/);
    assert.match(security, /TLS 1\.3/);
    assert.doesNotMatch(security, /AES-256|role-based|RBAC|security reviews|security review/i);
  }
});

test("localized privacy and terms match platform data and billing truth", () => {
  const unsupportedLegalClaims = [
    /12\s+(?:months?|ay|mes(?:es)?|monate|mois|شهراً)/i,
    /(?:train(?:ing)?|entrenar|training|entraîner|eğit|تدريب)[^.]{0,80}(?:AI|IA|KI|yapay zekâ|الذكاء الاصطناعي)/i,
    /(?:encrypted PostgreSQL|PostgreSQL[^.]{0,40}(?:encrypted|cifrad|verschlüssel|chiffr|şifre|مشفّر))/i,
    /(?:all associated data|tüm ilişkili ver|todos los datos asociados|aller zugehörigen Daten|toutes les données associées|جميع البيانات المرتبطة)/i,
  ];

  const deletionParity = {
    ar: ["أعضاء آخرون", "مساحة العمل"],
    de: ["andere Mitglieder", "Workspace"],
    en: ["other members", "workspace"],
    es: ["otros miembros", "espacio de trabajo"],
    fr: ["d'autres membres", "espace de travail"],
    tr: ["diğer üyeler", "çalışma alanı"],
  };

  for (const locale of LOCALES) {
    const messages = JSON.parse(read(`packages/ui/messages/${locale}.json`));
    const privacy = messages.static?.legal?.privacy;
    const terms = messages.static?.legal?.terms;
    const pricingFaq = messages.pricing?.faq;
    assert.equal(privacy?.sections?.length, 8, `${locale}: privacy structure drift`);
    assert.equal(terms?.sections?.length, 10, `${locale}: terms structure drift`);
    assert.ok(Array.isArray(pricingFaq), `${locale}: pricing FAQ structure drift`);

    const privacyCopy = privacy.sections.map(({ body }) => body).join("\n");
    const termsCopy = terms.sections.map(({ body }) => body).join("\n");
    const faqCopy = pricingFaq.map(({ a }) => a).join("\n");
    for (const vendor of ["Stripe", "Apple App Store", "Google Play", "Expo", "Sentry"]) {
      assert.match(privacyCopy, new RegExp(vendor), `${locale}: privacy omits ${vendor}`);
    }
    for (const vendor of ["Stripe", "Apple App Store", "Google Play"]) {
      assert.match(termsCopy, new RegExp(vendor), `${locale}: terms omit ${vendor} billing`);
      assert.match(faqCopy, new RegExp(vendor), `${locale}: FAQ omits ${vendor} subscription management`);
    }
    for (const phrase of deletionParity[locale]) {
      assert.ok(privacyCopy.includes(phrase), `${locale}: tenant-bound deletion truth omits ${phrase}`);
    }
    for (const pattern of unsupportedLegalClaims) {
      assert.doesNotMatch(privacyCopy, pattern, `${locale}: unsupported privacy promise remains`);
      assert.doesNotMatch(faqCopy, pattern, `${locale}: unsupported FAQ promise remains`);
    }
    assert.doesNotMatch(faqCopy, /(?:never|asla|jamás|nie|jamais|أبدًا)[^.]{0,100}(?:share|paylaş|compart|teil|partag|نشارك)/i);
  }

  const english = JSON.parse(read("packages/ui/messages/en.json"));
  const englishPrivacy = english.static.legal.privacy.sections.map(({ body }) => body).join("\n");
  const englishTerms = english.static.legal.terms.sections.map(({ body }) => body).join("\n");
  const englishFaq = english.pricing.faq.map(({ a }) => a).join("\n");
  assert.match(englishPrivacy, /push token, platform, device name, and OS version/);
  assert.match(englishPrivacy, /product, transaction or purchase token, receipt, status, and subscription dates/);
  assert.match(englishPrivacy, /Sentry may receive crash, trace, and session diagnostic events/);
  assert.match(englishTerms, /Web subscriptions are billed through Stripe/);
  assert.match(englishTerms, /In-app subscriptions are billed by Apple through the App Store or by Google through Google Play/);
  assert.match(englishTerms, /Cancellation does not itself delete your account or tenant workspace data/);
  assert.match(englishFaq, /Manage Stripe web subscriptions in web billing settings/);
  assert.match(englishFaq, /Manage Apple App Store or Google Play subscriptions in that store/);
  assert.match(englishFaq, /Content may be sent to AI providers you select or connect for requested workflows/);
  assert.match(englishFaq, /Provider handling follows the applicable provider terms and settings/);
});

test("GDPR transfer copy cannot name unevidenced processors or legal mechanisms", () => {
  const gdpr = read("packages/ui/app/gdpr/page.tsx");
  assert.doesNotMatch(
    gdpr,
    /\b(?:Stripe|SendGrid|HubSpot|Google|GitHub|Adyen|Braintree|PayPal)\b|Standard Contractual Clauses|\bSCCs?\b/,
  );
  assert.doesNotMatch(gdpr, /card details[^.]{0,120}\bhandles\b|\bhandles\b[^.]{0,120}card details/i);
  assert.match(gdpr, /current payment provider and deployment/i);
  assert.match(gdpr, /current provider and deployment evidence/i);
});

test("install and download edge behavior is fail-closed without changing their source routes", () => {
  const surface = read("packages/ui/lib/surface-domain.ts");
  const middleware = read("packages/ui/middleware.ts");
  assert.match(surface, /isPublicInstallerPath/);
  assert.match(surface, /normalized === ["']\/install["']/);
  assert.match(surface, /normalized === ["']\/install\.sh["']/);
  assert.match(surface, /normalized\.startsWith\(["']\/install\/["']\)/);
  assert.match(middleware, /isPublicInstallerPath\(request\.nextUrl\.pathname\)/);
  assert.match(surface, /isPublicDownloadPath/);
  assert.match(middleware, /status:\s*503/);
  assert.match(middleware, /not publicly available/i);
  assert.match(surface, /["']\/download["']/);
  assert.match(surface, /canonicalUrl\(PUBLIC_HOST,\s*["']\/docs\/getting-started["']/);
  assert.match(middleware, /308/);
});

test("edge proxy configs isolate cookies, CSP, and CORS", () => {
  const caddy = read("ENV/nginx/Caddyfile");
  const nginx = read("ENV/nginx/braavolabs.conf");

  assert.match(caddy, /header_down -Set-Cookie/, "www must not forward upstream cookies");
  assert.match(caddy, /https:\/\/api\.braavolabs\.com/, "app CSP must name the API origin");
  assert.match(nginx, /proxy_hide_header Set-Cookie/, "www must not forward upstream cookies");
  assert.match(nginx, /proxy_cookie_domain off/, "authenticated cookies must remain host-only");
  assert.doesNotMatch(caddy, /Access-Control-Allow-Origin\s+"https:\/\/app\.braavolabs\.com"/);
  assert.doesNotMatch(nginx, /add_header Access-Control-Allow-Origin/);
  const middleware = read("packages/ui/middleware.ts");
  assert.match(middleware, /process\.env\.NODE_ENV\s*===\s*["']development["']/);
  assert.match(middleware, /unsafe-eval/);
});

test("nginx preserves raw request authority and rejects synthesized hosts", () => {
  const nginx = read("ENV/nginx/braavolabs.conf");
  assert.match(nginx, /map\s+["']\$host\|\$http_host["']\s+\$braavolabs_authority_valid\s*\{/);
  assert.equal(
    (nginx.match(/if\s*\(\$braavolabs_authority_valid\s*=\s*0\)\s*\{\s*return\s+421;\s*\}/g) ?? []).length,
    4,
    "every HTTP, public, API, and app server must reject missing or mismatched authority",
  );
  assert.doesNotMatch(nginx, /proxy_set_header\s+Host\s+\$host;/);
  assert.ok((nginx.match(/proxy_set_header\s+Host\s+\$http_host;/g) ?? []).length >= 7);
  assert.ok((nginx.match(/proxy_set_header\s+X-Forwarded-Host\s+\$host;/g) ?? []).length >= 7);
});

test("nginx static-asset cache headers cannot shadow parent security headers", () => {
  const nginx = read("ENV/nginx/braavolabs.conf");
  const staticBlocks = [...nginx.matchAll(/location \/_next\/static\/ \{([\s\S]*?)^\s{4}\}/gm)].map((match) => match[1]);
  assert.equal(staticBlocks.length, 2, "www and app must each define one static-asset location");

  for (const [index, block] of staticBlocks.entries()) {
    for (const header of [
      "Strict-Transport-Security",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Content-Security-Policy",
      "Cross-Origin-Resource-Policy",
    ]) {
      const line = block.split("\n").find((candidate) => new RegExp(`^\\s*add_header\\s+${header}\\s+`).test(candidate));
      assert.ok(line?.trim().endsWith(" always;"), `static block ${index + 1} drops ${header}`);
    }
    assert.match(block, /add_header\s+Cache-Control\b[^;]*;/);
  }

  for (const header of ["Referrer-Policy", "Permissions-Policy"]) {
    const line = staticBlocks[0].split("\n").find((candidate) => new RegExp(`^\\s*add_header\\s+${header}\\s+`).test(candidate));
    assert.ok(line?.trim().endsWith(" always;"), `www static block drops ${header}`);
  }
});

test("UI build keeps the Sentry upload token ephemeral", () => {
  const workflow = read(".github/workflows/deploy.yml");
  const dockerfile = read("ENV/Dockerfile.ui");
  assert.doesNotMatch(workflow, /^\s*SENTRY_AUTH_TOKEN=.*$/m);
  assert.doesNotMatch(dockerfile, /^ARG\s+SENTRY_AUTH_TOKEN\b/m);
  assert.doesNotMatch(dockerfile, /^ENV\s+SENTRY_AUTH_TOKEN\b/m);
  assert.match(workflow, /secrets:\s*\|[\s\S]*sentry_auth_token=\$\{\{\s*secrets\.SENTRY_AUTH_TOKEN\s*\}\}/);
  assert.match(dockerfile, /RUN\s+--mount=type=secret,id=sentry_auth_token\s+\\/);
  assert.doesNotMatch(dockerfile, /id=sentry_auth_token,required=true/);
  assert.match(dockerfile, /id=sentry_cli,target=\/run\/secrets\/sentry-cli,mode=0555/);
  assert.match(dockerfile, /\/run\/secrets\/sentry_auth_token/);
});

test("deploy workflow delegates one fail-closed release invocation", () => {
  const workflow = read(".github/workflows/deploy.yml");
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /scripts\/deploy-platform\.sh/);
  assert.equal((workflow.match(/scripts\/deploy-platform\.sh/g) ?? []).length, 1);
  assert.match(workflow, /LIGHTSAIL_KNOWN_HOSTS/);
  assert.match(workflow, /LIGHTSAIL_HOST_KEY_SHA256/);
  assert.match(workflow, /SSH_KNOWN_HOSTS_FILE/);
  assert.match(workflow, /PREVIOUS_RELEASE_COMMIT:\s*\$\{\{ vars\.BRAAVOLABS_PREVIOUS_GOOD_COMMIT \}\}/);
  assert.match(workflow, /trap\s+cleanup\s+EXIT/);
  assert.match(workflow, /trap\s+signal_cleanup\s+HUP\s+INT\s+TERM/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/);
  assert.doesNotMatch(workflow, /prisma migrate resolve/);
  assert.doesNotMatch(workflow, /prisma migrate deploy\s*\|\|/);
  assert.doesNotMatch(workflow, /migration step skipped|api restart skipped/);
});
