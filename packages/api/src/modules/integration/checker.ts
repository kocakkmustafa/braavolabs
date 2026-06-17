import { prisma } from "../../lib/db";
import { decryptForTenant } from "../../lib/encryption";

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

  // Messaging
  send_slack_message: "SLACK",
  send_discord_message: "DISCORD",
  send_whatsapp_message: "WHATSAPP",

  // Productivity
  create_notion_page: "NOTION",
  update_notion_database: "NOTION",
  create_airtable_record: "AIRTABLE",
  update_airtable_record: "AIRTABLE",

  // Google Workspace
  create_calendar_event: "GOOGLE_CALENDAR",
  update_calendar_event: "GOOGLE_CALENDAR",
  create_google_doc: "GOOGLE_DOCS",
  append_google_doc: "GOOGLE_DOCS",
  read_google_sheet: "GOOGLE_SHEETS",
  write_google_sheet: "GOOGLE_SHEETS",

  // E-commerce / CMS
  create_shopify_product: "SHOPIFY",
  update_shopify_order: "SHOPIFY",
  create_wordpress_post: "WORDPRESS",
  update_wordpress_post: "WORDPRESS",

  // Social (extended)
  publish_facebook: "FACEBOOK",

  // Email marketing
  add_mailchimp_subscriber: "MAILCHIMP",
  send_mailchimp_campaign: "MAILCHIMP",

  // CRM / Support
  create_intercom_conversation: "INTERCOM",
  create_zendesk_ticket: "ZENDESK",
  update_zendesk_ticket: "ZENDESK",

  // Scheduling
  create_calendly_event: "CALENDLY",

  // Dev tools
  create_github_issue: "GITHUB",
  create_github_pr: "GITHUB",
  create_trello_card: "TRELLO",
  update_trello_card: "TRELLO",
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
  SLACK: {
    name: "Slack",
    description: "Send messages and manage Slack channels",
    icon: "💬",
    fields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "xoxb-..." },
      { key: "webhookUrl", label: "Webhook URL (optional)", type: "text", placeholder: "https://hooks.slack.com/services/..." },
    ],
    docsUrl: "https://api.slack.com/start/building",
    setupGuide: "1. Go to api.slack.com/apps\n2. Create a new app from scratch\n3. Under 'OAuth & Permissions' add bot scopes: chat:write, channels:read\n4. Install app to workspace and copy Bot Token\n5. (Optional) Create Incoming Webhook for simple posting",
  },
  DISCORD: {
    name: "Discord",
    description: "Send messages and manage Discord server channels",
    icon: "🎮",
    fields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "Your Discord bot token" },
      { key: "webhookUrl", label: "Webhook URL (optional)", type: "text", placeholder: "https://discord.com/api/webhooks/..." },
    ],
    docsUrl: "https://discord.com/developers/docs/intro",
    setupGuide: "1. Go to discord.com/developers/applications\n2. Create a New Application\n3. Under 'Bot' tab, add a bot and copy the token\n4. (Optional) Create a Webhook in your server channel settings",
  },
  WHATSAPP: {
    name: "WhatsApp Business",
    description: "Send messages via WhatsApp Business API",
    icon: "📱",
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "Meta access token" },
      { key: "phoneNumberId", label: "Phone Number ID", type: "text", placeholder: "Your WhatsApp phone number ID" },
      { key: "businessAccountId", label: "Business Account ID", type: "text", placeholder: "Your WhatsApp Business Account ID" },
    ],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
    setupGuide: "1. Create a Meta Developer account\n2. Create a Meta App with WhatsApp product\n3. Set up WhatsApp Business Account\n4. Get temporary or permanent access token from Meta Business Suite",
  },
  GOOGLE_CALENDAR: {
    name: "Google Calendar",
    description: "Create and manage calendar events",
    icon: "📅",
    fields: [
      { key: "clientId", label: "OAuth Client ID", type: "text", placeholder: "Google OAuth client ID" },
      { key: "clientSecret", label: "OAuth Client Secret", type: "password", placeholder: "Google OAuth client secret" },
      { key: "refreshToken", label: "Refresh Token", type: "password", placeholder: "OAuth refresh token" },
    ],
    docsUrl: "https://developers.google.com/calendar/api/guides/overview",
    setupGuide: "1. Go to Google Cloud Console\n2. Enable Google Calendar API\n3. Create OAuth 2.0 credentials\n4. Authorize and obtain a refresh token via OAuth flow",
  },
  GOOGLE_DOCS: {
    name: "Google Docs",
    description: "Create and edit Google Documents",
    icon: "📝",
    fields: [
      { key: "clientId", label: "OAuth Client ID", type: "text", placeholder: "Google OAuth client ID" },
      { key: "clientSecret", label: "OAuth Client Secret", type: "password", placeholder: "Google OAuth client secret" },
      { key: "refreshToken", label: "Refresh Token", type: "password", placeholder: "OAuth refresh token" },
    ],
    docsUrl: "https://developers.google.com/docs/api/reference/rest",
    setupGuide: "1. Go to Google Cloud Console\n2. Enable Google Docs API\n3. Create OAuth 2.0 credentials with docs scope\n4. Authorize and obtain a refresh token via OAuth flow",
  },
  GOOGLE_SHEETS: {
    name: "Google Sheets",
    description: "Read and write Google Spreadsheets",
    icon: "📊",
    fields: [
      { key: "clientId", label: "OAuth Client ID", type: "text", placeholder: "Google OAuth client ID" },
      { key: "clientSecret", label: "OAuth Client Secret", type: "password", placeholder: "Google OAuth client secret" },
      { key: "refreshToken", label: "Refresh Token", type: "password", placeholder: "OAuth refresh token" },
    ],
    docsUrl: "https://developers.google.com/sheets/api/reference/rest",
    setupGuide: "1. Go to Google Cloud Console\n2. Enable Google Sheets API\n3. Create OAuth 2.0 credentials with spreadsheets scope\n4. Authorize and obtain a refresh token via OAuth flow",
  },
  NOTION: {
    name: "Notion",
    description: "Create and manage Notion pages and databases",
    icon: "📓",
    fields: [
      { key: "apiKey", label: "Integration Token", type: "password", placeholder: "secret_..." },
    ],
    docsUrl: "https://developers.notion.com/docs/getting-started",
    setupGuide: "1. Go to notion.so/my-integrations\n2. Create a new integration\n3. Copy the Internal Integration Token\n4. Share your Notion pages/databases with the integration",
  },
  AIRTABLE: {
    name: "Airtable",
    description: "Read and write Airtable bases and records",
    icon: "🗂️",
    fields: [
      { key: "apiKey", label: "Personal Access Token", type: "password", placeholder: "pat..." },
      { key: "baseId", label: "Base ID (optional default)", type: "text", placeholder: "appXXXXXXXXXXXXXX" },
    ],
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    setupGuide: "1. Go to airtable.com/create/tokens\n2. Create a personal access token\n3. Add required scopes: data.records:read, data.records:write\n4. Copy your Base ID from the URL when viewing a base",
  },
  SHOPIFY: {
    name: "Shopify",
    description: "Manage products, orders, and customers in Shopify",
    icon: "🛍️",
    fields: [
      { key: "shopDomain", label: "Shop Domain", type: "text", placeholder: "your-store.myshopify.com" },
      { key: "accessToken", label: "Admin API Access Token", type: "password", placeholder: "shpat_..." },
    ],
    docsUrl: "https://shopify.dev/docs/api/admin-rest",
    setupGuide: "1. Go to your Shopify Admin > Apps > Develop apps\n2. Create a custom app\n3. Configure Admin API access scopes\n4. Install the app and copy the Admin API access token",
  },
  WORDPRESS: {
    name: "WordPress",
    description: "Create and manage WordPress posts and pages",
    icon: "📰",
    fields: [
      { key: "siteUrl", label: "Site URL", type: "text", placeholder: "https://yoursite.com" },
      { key: "username", label: "Username", type: "text", placeholder: "WordPress username" },
      { key: "applicationPassword", label: "Application Password", type: "password", placeholder: "xxxx xxxx xxxx xxxx xxxx xxxx" },
    ],
    docsUrl: "https://developer.wordpress.org/rest-api/",
    setupGuide: "1. Log in to your WordPress admin\n2. Go to Users > Profile\n3. Scroll to Application Passwords section\n4. Add a new application password and copy it",
  },
  FACEBOOK: {
    name: "Facebook",
    description: "Publish posts and manage Facebook Pages",
    icon: "👍",
    fields: [
      { key: "accessToken", label: "Page Access Token", type: "password", placeholder: "Long-lived page access token" },
      { key: "pageId", label: "Page ID", type: "text", placeholder: "Your Facebook Page ID" },
    ],
    docsUrl: "https://developers.facebook.com/docs/pages-api",
    setupGuide: "1. Create a Meta App in Meta Developer Portal\n2. Add Facebook Login product\n3. Generate a long-lived page access token\n4. Find your Page ID in Page Settings > About",
  },
  MAILCHIMP: {
    name: "Mailchimp",
    description: "Manage subscribers and send email campaigns",
    icon: "🐒",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "xxxxxxxxxxxx-us1" },
      { key: "serverPrefix", label: "Server Prefix", type: "text", placeholder: "us1" },
    ],
    docsUrl: "https://mailchimp.com/developer/marketing/docs/fundamentals/",
    setupGuide: "1. Log in to Mailchimp\n2. Go to Account > Extras > API Keys\n3. Create an API key\n4. Note the server prefix from the key (e.g., us1)",
  },
  INTERCOM: {
    name: "Intercom",
    description: "Manage customer conversations and contacts",
    icon: "💁",
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "Your Intercom access token" },
    ],
    docsUrl: "https://developers.intercom.com/docs/build-an-integration/getting-started/",
    setupGuide: "1. Go to app.intercom.com/a/apps/_/developer-hub\n2. Create a new app or use existing\n3. Go to Authentication and copy Access Token\n4. Ensure required permissions are enabled",
  },
  ZENDESK: {
    name: "Zendesk",
    description: "Create and manage support tickets",
    icon: "🎫",
    fields: [
      { key: "subdomain", label: "Subdomain", type: "text", placeholder: "your-company" },
      { key: "email", label: "Admin Email", type: "text", placeholder: "admin@yourcompany.com" },
      { key: "apiToken", label: "API Token", type: "password", placeholder: "Your Zendesk API token" },
    ],
    docsUrl: "https://developer.zendesk.com/api-reference/",
    setupGuide: "1. Log in to Zendesk Admin Center\n2. Go to Apps and Integrations > APIs > Zendesk API\n3. Enable Token Access\n4. Add an API token and copy it",
  },
  CALENDLY: {
    name: "Calendly",
    description: "Manage scheduling links and event types",
    icon: "🗓️",
    fields: [
      { key: "personalAccessToken", label: "Personal Access Token", type: "password", placeholder: "Your Calendly PAT" },
    ],
    docsUrl: "https://developer.calendly.com/api-docs/",
    setupGuide: "1. Log in to Calendly\n2. Go to Integrations > API & Webhooks\n3. Generate a Personal Access Token\n4. Copy and store the token securely",
  },
  GITHUB: {
    name: "GitHub",
    description: "Create issues, pull requests, and manage repositories",
    icon: "🐙",
    fields: [
      { key: "personalAccessToken", label: "Personal Access Token", type: "password", placeholder: "ghp_..." },
      { key: "defaultOwner", label: "Default Owner/Org (optional)", type: "text", placeholder: "your-org" },
    ],
    docsUrl: "https://docs.github.com/en/rest",
    setupGuide: "1. Go to github.com/settings/tokens\n2. Generate a new token (classic or fine-grained)\n3. Select required scopes: repo, issues, pull requests\n4. Copy the token",
  },
  TRELLO: {
    name: "Trello",
    description: "Create and manage cards on Trello boards",
    icon: "📋",
    fields: [
      { key: "apiKey", label: "API Key", type: "text", placeholder: "Your Trello API key" },
      { key: "token", label: "Token", type: "password", placeholder: "Your Trello token" },
    ],
    docsUrl: "https://developer.atlassian.com/cloud/trello/rest/",
    setupGuide: "1. Go to trello.com/app-key\n2. Copy your API Key\n3. Click 'Token' link to generate a token\n4. Authorize the application and copy the token",
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
    include: { company: { select: { tenantId: true } } },
  });

  if (!integration) return null;

  try {
    return JSON.parse(decryptForTenant(integration.credentials, integration.company.tenantId));
  } catch {
    return null;
  }
}
