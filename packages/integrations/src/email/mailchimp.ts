/**
 * Mailchimp Marketing API Client
 *
 * Manage subscribers, lists, and email campaigns.
 */

export interface MailchimpConfig {
  apiKey: string;
  serverPrefix: string;
}

function mcBase(config: MailchimpConfig): string {
  return `https://${config.serverPrefix}.api.mailchimp.com/3.0`;
}

function mcHeaders(config: MailchimpConfig): Record<string, string> {
  const credentials = Buffer.from(`anystring:${config.apiKey}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
  };
}

/**
 * Add or update a subscriber in a list.
 */
export async function upsertMailchimpSubscriber(
  config: MailchimpConfig,
  listId: string,
  email: string,
  mergeFields?: Record<string, string>,
  tags?: string[],
): Promise<{ id: string; status: string }> {
  const subscriberHash = require("crypto")
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  const body: any = {
    email_address: email,
    status_if_new: "subscribed",
    status: "subscribed",
  };
  if (mergeFields) body.merge_fields = mergeFields;
  if (tags?.length) body.tags = tags.map((t) => ({ name: t, status: "active" }));

  const res = await fetch(`${mcBase(config)}/lists/${listId}/members/${subscriberHash}`, {
    method: "PUT",
    headers: mcHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Mailchimp upsert subscriber failed: ${err?.detail ?? res.status}`);
  }

  const data: any = await res.json();
  return { id: data.id, status: data.status };
}

/**
 * Get all lists/audiences.
 */
export async function listMailchimpAudiences(
  config: MailchimpConfig,
): Promise<Array<{ id: string; name: string; memberCount: number }>> {
  const res = await fetch(`${mcBase(config)}/lists?count=100`, {
    headers: mcHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Mailchimp list audiences failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.lists ?? []).map((l: any) => ({
    id: l.id,
    name: l.name,
    memberCount: l.stats?.member_count ?? 0,
  }));
}

/**
 * Create a campaign.
 */
export async function createMailchimpCampaign(
  config: MailchimpConfig,
  listId: string,
  subject: string,
  fromName: string,
  replyTo: string,
  html: string,
): Promise<{ campaignId: string }> {
  const res = await fetch(`${mcBase(config)}/campaigns`, {
    method: "POST",
    headers: mcHeaders(config),
    body: JSON.stringify({
      type: "regular",
      recipients: { list_id: listId },
      settings: {
        subject_line: subject,
        from_name: fromName,
        reply_to: replyTo,
      },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Mailchimp create campaign failed: ${err?.detail ?? res.status}`);
  }

  const campaign: any = await res.json();

  // Set content
  await fetch(`${mcBase(config)}/campaigns/${campaign.id}/content`, {
    method: "PUT",
    headers: mcHeaders(config),
    body: JSON.stringify({ html }),
  });

  return { campaignId: campaign.id };
}

/**
 * Send a campaign.
 */
export async function sendMailchimpCampaign(
  config: MailchimpConfig,
  campaignId: string,
): Promise<void> {
  const res = await fetch(`${mcBase(config)}/campaigns/${campaignId}/actions/send`, {
    method: "POST",
    headers: mcHeaders(config),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Mailchimp send campaign failed: ${err?.detail ?? res.status}`);
  }
}

/**
 * Test Mailchimp connection.
 */
export async function testMailchimpConnection(
  config: MailchimpConfig,
): Promise<{ ok: boolean; accountName: string; email: string }> {
  const res = await fetch(`${mcBase(config)}/`, {
    headers: mcHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Mailchimp connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return {
    ok: true,
    accountName: data.account_name ?? "",
    email: data.email ?? "",
  };
}
