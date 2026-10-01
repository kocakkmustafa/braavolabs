/**
 * The subprocessor data map (BR-P1-005 #4, roadmap §7.4).
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `ui/app/gdpr/page.tsx` has eight sections and none is a subprocessor
 *     list; the word does not appear in the file.
 *   - The application accepts credentials for Stripe, SendGrid, Sentry,
 *     Apple, Google, GitHub, RevenueCat, Vapi and four model vendors, and
 *     names none of them to a data subject.
 *
 * A hand-maintained list is a claim that rots. For a processing disclosure
 * that is not a stale doc — it is a wrong statement to someone exercising a
 * right. So the cloud model half is DERIVED from PROVIDER_INFO, and a gate
 * requires every third-party credential the app accepts to resolve to a
 * declaration here or to a first-party exemption WITH a reason. Adding an
 * integration means adding a credential, which is the moment this file has to
 * change — rather than whenever someone next remembers the page exists.
 *
 * Deliberately NOT a legal opinion. It records what the code does: who is
 * contacted, for what, with which categories of data, and where. Whether the
 * resulting posture satisfies a given regime is a lawyer's call, and roadmap
 * §7.4 explicitly forbids a blanket "GDPR compliant" claim.
 */

export interface Subprocessor {
  /** Stable id. Model vendors are `llm:<PROVIDER>`, derived. */
  id: string;
  name: string;
  purpose: string;
  /** WHAT is sent. A name with no categories discloses nothing. */
  dataCategories: string[];
  transferRegion: "EEA" | "UK" | "US" | "global" | "customer-chosen";
  /** Env-var prefixes that imply this processor — the anti-drift link. */
  envPrefixes: string[];
  /** True when the customer supplies the credential and chooses the vendor. */
  customerControlled?: boolean;
  /**
   * True when WE hold the key and dial the vendor on the user's behalf.
   * Mutually exclusive with customerControlled, and enforced by a gate: a
   * vendor we fund is one WE chose, so the transfer is our decision to
   * justify, not the subject's.
   */
  systemFunded?: boolean;
}

/**
 * Secrets that are OURS, not a third party's, with the reason.
 *
 * An unexplained exemption is indistinguishable from an oversight, so the
 * gate rejects an empty one.
 */
export const FIRST_PARTY_SECRETS: Record<string, string> = {
  ENCRYPTION_KEY: "our own at-rest encryption key; never leaves the deployment",
  JWT_SECRET: "signs our own session tokens; no third party sees it",
  LICENSE_JWT_SECRET: "signs our own offline pipeline licences; no third party sees it",
  HEALTH_PROBE_KEY: "authenticates our own uptime probe against our own health route",
  BENCH_WORKER_TOKEN: "authenticates our own benchmark worker to our own API",
  VOICE_CUSTOM_WEBHOOK_SECRET: "an HMAC key we hold to VERIFY inbound webhook signatures; nothing is sent using it, so it names no recipient",
};

/**
 * Variables declared in `.env.example` that NO code reads.
 *
 * They are not recipients — nothing is sent anywhere — but they are also not
 * first-party secrets, and calling them either would be false. Recorded as a
 * third thing so the choice is visible: whoever wires one of these up must
 * either declare a subprocessor or delete the line. Found only once the gate
 * started reading `.env.example` as well as the schema.
 */
export const DECLARED_BUT_UNUSED: Record<string, string> = {
  VOYAGE_API_KEY: "no reference anywhere in packages/api/src; embedding vendor never wired up",
  TIKTOK_CLIENT_KEY: "no reference in the API; connector catalogue entry only",
  TIKTOK_CLIENT_SECRET: "no reference in the API; connector catalogue entry only",
  LINKEDIN_CLIENT_SECRET: "no reference in the API; connector catalogue entry only",
  N8N_WEBHOOK_URL: "no reference in the API; automation connector is tenant-configured",
  N8N_API_KEY: "no reference in the API; automation connector is tenant-configured",
};

/** Processors we contact regardless of what the customer configures. */
const INFRA_SUBPROCESSORS: Subprocessor[] = [
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Takes card payments and drives subscription lifecycle webhooks.",
    dataCategories: ["billing email", "subscription state", "payment metadata"],
    transferRegion: "US",
    envPrefixes: ["STRIPE_"],
  },
  {
    id: "revenuecat",
    name: "RevenueCat",
    purpose: "Reconciles mobile in-app purchase state across Apple and Google.",
    dataCategories: ["purchase identifiers", "subscription state"],
    transferRegion: "US",
    envPrefixes: ["REVENUECAT_"],
  },
  {
    id: "apple",
    name: "Apple",
    purpose: "Sign in with Apple, and App Store purchase verification and notifications.",
    dataCategories: ["account identifier", "purchase receipts"],
    transferRegion: "global",
    envPrefixes: ["APPLE_"],
  },
  {
    id: "google",
    name: "Google",
    purpose: "Google sign-in, and Play purchase verification and real-time notifications.",
    dataCategories: ["account identifier", "email", "purchase receipts"],
    transferRegion: "global",
    envPrefixes: ["GOOGLE_CLIENT", "GOOGLE_PLAY", "GOOGLE_PUBSUB"],
  },
  {
    id: "github",
    name: "GitHub",
    purpose: "Authenticates GitHub sign-in and returns the account profile we store.",
    dataCategories: ["account identifier", "email"],
    transferRegion: "US",
    envPrefixes: ["GITHUB_"],
  },
  {
    id: "sendgrid",
    name: "Twilio SendGrid",
    purpose: "Delivers transactional email such as verification and approval notices.",
    dataCategories: ["email address", "message content we generate"],
    transferRegion: "US",
    envPrefixes: ["SENDGRID_"],
  },
  {
    id: "sentry",
    name: "Sentry",
    purpose: "Receives application error reports so faults can be diagnosed.",
    // NOT "user identifier": `lib/sentry.ts` sets `sendDefaultPii: false` and
    // there is no setUser call site anywhere in the API — the only scope tags
    // are requestId and path. An earlier version of this line was guessed,
    // which is precisely what this file is supposed to stop.
    dataCategories: [
      "error traces",
      "request metadata (request id, path)",
      "error messages, which may incidentally contain personal data",
    ],
    transferRegion: "US",
    envPrefixes: ["SENTRY_"],
  },
  {
    id: "aws-s3",
    name: "Amazon Web Services (S3)",
    purpose:
      "Stores the encrypted nightly database backup. This is a complete copy of the " +
      "production database, so every category of data listed elsewhere on this page is " +
      "also present here.",
    dataCategories: ["complete database backup"],
    transferRegion: "US",
    // Narrow on purpose. A bare `AWS_` prefix would absorb any future AWS
    // credential — SES, SQS — into the backup entry, which is the very
    // "one processor hiding inside another" defect the gate exists to catch.
    envPrefixes: ["BACKUP_S3_", "AWS_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
  },
  {
    id: "aws-lightsail",
    name: "Amazon Web Services (Lightsail, Frankfurt)",
    purpose: "Hosts the application and the production database.",
    dataCategories: ["all stored data", "server logs"],
    transferRegion: "EEA",
    envPrefixes: ["DATABASE_URL", "REDIS_URL"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    purpose: "Terminates TLS and proxies every request to the application.",
    dataCategories: ["request metadata", "IP address", "request and response bodies in transit"],
    transferRegion: "global",
    envPrefixes: ["TRUST_PROXY_HOPS"],
  },
  {
    id: "expo",
    name: "Expo",
    purpose:
      "Relays push notifications to your mobile device, including the notification " +
      "title and body.",
    dataCategories: ["device push token", "notification title and body"],
    transferRegion: "US",
    // Deliberately empty: the Expo push API requires NO credential, which is
    // exactly why the credential rule could never see it. A key is evidence of
    // a recipient; its absence is not evidence of none.
    envPrefixes: [],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    purpose:
      "Syncs contacts and deals when the CRM module is used. The access token is held " +
      "by us in server configuration, not by you — so this is our processor, not one " +
      "you connected.",
    dataCategories: ["contact names and emails", "deal records"],
    transferRegion: "US",
    envPrefixes: ["HUBSPOT_"],
  },
  {
    id: "plausible",
    name: "Plausible Analytics",
    purpose: "Receives page views, referrers and outbound-link clicks from the website.",
    dataCategories: ["page URL", "referrer", "IP address", "outbound link clicks"],
    transferRegion: "EEA",
    envPrefixes: ["NEXT_PUBLIC_PLAUSIBLE"],
  },
  {
    id: "google-fonts",
    name: "Google (Fonts)",
    purpose:
      "Serves the web fonts used across the site. Your browser requests them directly, " +
      "so Google receives your IP address on every page load — including this one.",
    dataCategories: ["IP address", "user agent"],
    transferRegion: "global",
    // No credential: a browser-side recipient, which the credential rule
    // cannot see by construction. Disclosed rather than inferred.
    envPrefixes: [],
  },
  {
    id: "web-search",
    name: "Tavily / Serper / Brave Search",
    purpose:
      "Runs web searches for the research module using keys WE hold — your search " +
      "query is sent to whichever provider is configured, and that choice is ours.",
    dataCategories: ["search query text"],
    transferRegion: "US",
    envPrefixes: ["TAVILY_", "SERPER_", "BRAVE_SEARCH_"],
  },
  {
    id: "vapi",
    name: "Vapi",
    purpose: "Runs voice calls when the voice module is enabled.",
    dataCategories: ["call audio", "transcripts", "phone numbers"],
    transferRegion: "US",
    envPrefixes: ["VAPI_"],
  },
];

/**
 * Cloud model vendors the product can reach.
 *
 * Declared here rather than derived, because this file has to be importable
 * by the public GDPR page — a legal disclosure that only renders when an API
 * call succeeds is not a disclosure. Completeness against the real provider
 * registry is enforced by a gate in the API package
 * (`lib/__tests__/subprocessors.test.ts`), which can see both: adding a cloud
 * provider without adding it here fails the build.
 *
 * Local providers are absent ON PURPOSE — roadmap §7.4's
 * "Local/BYOK/cloud/managed ayrımı". Listing Ollama would be false: nothing
 * leaves the user's machine, and a data map that overstates is as wrong as
 * one that understates.
 */
const CLOUD_MODEL_VENDORS: Array<{ id: string; name: string }> = [
  { id: "ANTHROPIC", name: "Anthropic Claude" },
  { id: "OPENAI", name: "OpenAI" },
  { id: "GOOGLE", name: "Google Gemini" },
  { id: "MISTRAL", name: "Mistral" },
  { id: "GROQ", name: "Groq" },
  { id: "OPENROUTER", name: "OpenRouter" },
  { id: "DEEPSEEK", name: "DeepSeek" },
  { id: "KIMI", name: "Kimi by Moonshot" },
  { id: "QWEN", name: "Qwen by Alibaba" },
  { id: "CEREBRAS", name: "Cerebras" },
  { id: "ZHIPU", name: "Zhipu GLM" },
];

/**
 * Vendors WE hold a key for and dial on the user's behalf.
 *
 * Free-plan trial traffic is pooled through Groq on our key
 * (`services/trial-llm.ts`), Forge onboarding uses our Cerebras/Groq/Zhipu
 * keys (`billing/trial-credit.service.ts`), and Anthropic is the paid system
 * fallback (`services/provider-chain.ts`). For those requests the user chose
 * neither the vendor nor the region, so calling the transfer "customer-chosen"
 * would tell them a decision of ours was theirs. A gate now forbids any entry
 * whose env prefix resolves to a variable in our OWN env.ts from being marked
 * customerControlled — the earlier rule could not tell "the customer's key"
 * from "our key with the same name".
 */
const SYSTEM_FUNDED_VENDORS: Array<{ id: string; name: string; region: Subprocessor["transferRegion"] }> = [
  { id: "GROQ", name: "Groq (trial pool)", region: "US" },
  { id: "CEREBRAS", name: "Cerebras (onboarding trial)", region: "US" },
  { id: "ZHIPU", name: "Zhipu GLM (onboarding trial)", region: "global" },
  { id: "ANTHROPIC", name: "Anthropic Claude (system fallback)", region: "US" },
];

export const SUBPROCESSORS: Subprocessor[] = [
  ...INFRA_SUBPROCESSORS,
  ...SYSTEM_FUNDED_VENDORS.map((v) => ({
    id: `llm-system:${v.id}`,
    name: v.name,
    purpose:
      "Runs model inference for trial and fallback traffic using a key WE hold — " +
      "you did not choose this vendor, and this transfer is our decision rather " +
      "than yours.",
    dataCategories: ["prompt content", "conversation context", "model output"],
    transferRegion: v.region,
    envPrefixes: [`${v.id}_API_KEY`],
    systemFunded: true,
  })),
  ...CLOUD_MODEL_VENDORS.map((v) => ({
    id: `llm:${v.id}`,
    name: v.name,
    purpose:
      "Runs model inference on prompts and context you send through the product, " +
      "using a key you supply.",
    dataCategories: ["prompt content", "conversation context", "model output"],
    // The customer picks the vendor and holds the key, so the destination is
    // their choice rather than ours. Naming a region would be a guess
    // presented to a data subject as a fact.
    transferRegion: "customer-chosen" as const,
    // No env prefix: a BYOK key is stored per tenant in the encrypted
    // credential vault, never in our environment. Claiming `<VENDOR>_API_KEY`
    // here is what let our own trial keys hide behind a "customer-chosen"
    // label.
    envPrefixes: [],
    customerControlled: true,
  })),
];
