import { prisma } from "../../lib/db";
import { decrypt } from "../../lib/encryption";

/**
 * Maps tool names to the integration provider they require.
 * Tools not in this map work without external integrations.
 */
export const TOOL_PROVIDER_MAP: Record<string, string> = {
  // Social publishing
  publish_tiktok: "TIKTOK",
  publish_instagram: "INSTAGRAM",
  publish_linkedin: "LINKEDIN",
  publish_youtube: "YOUTUBE",
  publish_twitter: "TWITTER",

  // AI generation
  generate_image: "OPENAI",
  generate_video: "RUNWAY",
  text_to_speech: "ELEVENLABS",

  // CRM
  sync_hubspot: "HUBSPOT",
  hubspot_create_contact: "HUBSPOT",
  hubspot_update_deal: "HUBSPOT",

  // Email
  send_email: "SENDGRID",
};

/**
 * Provider metadata — display info and setup instructions.
 */
export const PROVIDER_INFO: Record<string, {
  name: string;
  description: string;
  icon: string;
  fields: Array<{ key: string; label: string; type: "text" | "password"; placeholder: string }>;
  docsUrl: string;
  setupGuide: string;
}> = {
  TIKTOK: {
    name: "TikTok",
    description: "Publish videos and track analytics on TikTok",
    icon: "🎵",
    fields: [
      { key: "clientKey", label: "Client Key", type: "text", placeholder: "Your TikTok app client key" },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "Your TikTok app client secret" },
    ],
    docsUrl: "https://developers.tiktok.com/doc/getting-started",
    setupGuide: "1. Go to TikTok Developer Portal\n2. Create a new app\n3. Copy Client Key and Client Secret\n4. Set redirect URI to your app URL + /callbacks/tiktok",
  },
  INSTAGRAM: {
    name: "Instagram",
    description: "Publish posts and stories to Instagram Business",
    icon: "📸",
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "Long-lived Instagram access token" },
      { key: "businessAccountId", label: "Business Account ID", type: "text", placeholder: "Your Instagram business account ID" },
    ],
    docsUrl: "https://developers.facebook.com/docs/instagram-api",
    setupGuide: "1. Create a Facebook App in Meta Developer Portal\n2. Add Instagram Basic Display product\n3. Generate a long-lived access token\n4. Find your Business Account ID in Instagram settings",
  },
  LINKEDIN: {
    name: "LinkedIn",
    description: "Publish articles and posts to LinkedIn",
    icon: "💼",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", placeholder: "LinkedIn app client ID" },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "LinkedIn app client secret" },
    ],
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/",
    setupGuide: "1. Go to LinkedIn Developer Portal\n2. Create an app\n3. Request 'w_member_social' permission\n4. Copy Client ID and Client Secret",
  },
  YOUTUBE: {
    name: "YouTube",
    description: "Upload videos and manage YouTube channel",
    icon: "🔴",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "YouTube Data API key" },
      { key: "clientId", label: "OAuth Client ID", type: "text", placeholder: "Google OAuth client ID" },
      { key: "clientSecret", label: "OAuth Client Secret", type: "password", placeholder: "Google OAuth client secret" },
    ],
    docsUrl: "https://developers.google.com/youtube/v3/getting-started",
    setupGuide: "1. Go to Google Cloud Console\n2. Enable YouTube Data API v3\n3. Create OAuth 2.0 credentials\n4. Copy API Key, Client ID, and Client Secret",
  },
  TWITTER: {
    name: "Twitter / X",
    description: "Post tweets and manage Twitter presence",
    icon: "🐦",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Twitter API key" },
      { key: "apiSecret", label: "API Secret", type: "password", placeholder: "Twitter API secret" },
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "Twitter access token" },
      { key: "accessSecret", label: "Access Token Secret", type: "password", placeholder: "Twitter access token secret" },
    ],
    docsUrl: "https://developer.twitter.com/en/docs/authentication",
    setupGuide: "1. Apply for Twitter Developer Account\n2. Create a project and app\n3. Generate API Key, Secret, Access Token, and Access Token Secret",
  },
  OPENAI: {
    name: "OpenAI (DALL-E)",
    description: "Generate images using DALL-E 3",
    icon: "🎨",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "sk-..." },
    ],
    docsUrl: "https://platform.openai.com/docs/guides/images",
    setupGuide: "1. Go to platform.openai.com\n2. Navigate to API Keys\n3. Create a new secret key\n4. Add billing information to your account",
  },
  RUNWAY: {
    name: "Runway ML",
    description: "Generate videos from text or images using Gen-3",
    icon: "🎬",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Runway API key" },
    ],
    docsUrl: "https://docs.runwayml.com/",
    setupGuide: "1. Sign up at runwayml.com\n2. Go to API settings in your account\n3. Generate an API key\n4. Choose a plan with API access",
  },
  ELEVENLABS: {
    name: "ElevenLabs",
    description: "Generate realistic AI voiceovers and text-to-speech",
    icon: "🔊",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your ElevenLabs API key" },
    ],
    docsUrl: "https://docs.elevenlabs.io/",
    setupGuide: "1. Sign up at elevenlabs.io\n2. Go to Profile Settings\n3. Copy your API Key\n4. Choose a plan based on character quota needs",
  },
  MIDJOURNEY: {
    name: "Midjourney",
    description: "Generate high-quality images via Midjourney API",
    icon: "🖼️",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Midjourney API key" },
    ],
    docsUrl: "https://docs.midjourney.com/",
    setupGuide: "1. Subscribe to Midjourney\n2. Access API through authorized third-party service\n3. Obtain your API key",
  },
  FLUX: {
    name: "Flux (Black Forest Labs)",
    description: "Generate images using Flux models",
    icon: "⚡",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Flux/BFL API key" },
    ],
    docsUrl: "https://docs.bfl.ml/",
    setupGuide: "1. Sign up at bfl.ml\n2. Generate an API key from your dashboard\n3. Add credits to your account",
  },
  PIKA: {
    name: "Pika",
    description: "Generate and edit videos with AI",
    icon: "🎥",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "Your Pika API key" },
    ],
    docsUrl: "https://pika.art/",
    setupGuide: "1. Sign up at pika.art\n2. Access API settings\n3. Generate your API key",
  },
  HUBSPOT: {
    name: "HubSpot CRM",
    description: "Sync contacts, deals, and manage CRM pipeline",
    icon: "🟠",
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "HubSpot private app access token" },
      { key: "portalId", label: "Portal ID", type: "text", placeholder: "Your HubSpot portal ID" },
    ],
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
    setupGuide: "1. Go to HubSpot Settings > Integrations > Private Apps\n2. Create a private app\n3. Select required scopes (contacts, deals, etc.)\n4. Copy the access token",
  },
  STRIPE: {
    name: "Stripe",
    description: "Payment processing and billing",
    icon: "💜",
    fields: [
      { key: "secretKey", label: "Secret Key", type: "password", placeholder: "sk_..." },
      { key: "webhookSecret", label: "Webhook Secret", type: "password", placeholder: "whsec_..." },
    ],
    docsUrl: "https://stripe.com/docs/api",
    setupGuide: "1. Go to Stripe Dashboard\n2. Navigate to Developers > API Keys\n3. Copy your Secret Key\n4. Set up webhooks and copy the Webhook Secret",
  },
  SENDGRID: {
    name: "SendGrid",
    description: "Transactional and marketing email delivery",
    icon: "📧",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "SG...." },
      { key: "fromEmail", label: "From Email", type: "text", placeholder: "noreply@yourdomain.com" },
    ],
    docsUrl: "https://docs.sendgrid.com/",
    setupGuide: "1. Sign up at sendgrid.com\n2. Go to Settings > API Keys\n3. Create an API Key with full access\n4. Verify your sender email domain",
  },
};

/**
 * Given a list of tool names, return the providers they require.
 */
export function getRequiredProviders(toolNames: string[]): string[] {
  const providers = new Set<string>();
  for (const tool of toolNames) {
    const provider = TOOL_PROVIDER_MAP[tool];
    if (provider) providers.add(provider);
  }
  return Array.from(providers);
}

/**
 * Check which integrations are missing for a company.
 */
export async function getMissingIntegrations(
  companyId: string,
  requiredProviders: string[],
): Promise<Array<{ provider: string; info: typeof PROVIDER_INFO[string] }>> {
  if (requiredProviders.length === 0) return [];

  const existing = await prisma.integration.findMany({
    where: {
      companyId,
      provider: { in: requiredProviders as any[] },
      status: "ACTIVE",
    },
  });

  const activeProviders = new Set(existing.map((i) => i.provider));

  return requiredProviders
    .filter((p) => !activeProviders.has(p as any))
    .map((provider) => ({
      provider,
      info: PROVIDER_INFO[provider] ?? { name: provider, description: "", icon: "🔌", fields: [], docsUrl: "", setupGuide: "" },
    }));
}

/**
 * Get decrypted credentials for a company's integration.
 */
export async function getActiveIntegration(
  companyId: string,
  provider: string,
): Promise<Record<string, string> | null> {
  const integration = await prisma.integration.findFirst({
    where: {
      companyId,
      provider: provider as any,
      status: "ACTIVE",
    },
  });

  if (!integration) return null;

  try {
    return JSON.parse(decrypt(integration.credentials));
  } catch {
    return null;
  }
}
