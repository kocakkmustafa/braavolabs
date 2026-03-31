/**
 * WhatsApp Business Cloud API Client
 *
 * Uses Meta's WhatsApp Business API (Cloud API).
 */

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
}

const WA_API_BASE = "https://graph.facebook.com/v20.0";

/**
 * Send a text message to a WhatsApp number.
 */
export async function sendWhatsAppMessage(
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<{ messageId: string }> {
  const res = await fetch(`${WA_API_BASE}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp send failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { messageId: data.messages?.[0]?.id ?? "" };
}

/**
 * Send a template message.
 */
export async function sendWhatsAppTemplate(
  config: WhatsAppConfig,
  to: string,
  templateName: string,
  languageCode: string,
  components?: unknown[],
): Promise<{ messageId: string }> {
  const res = await fetch(`${WA_API_BASE}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp template send failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { messageId: data.messages?.[0]?.id ?? "" };
}

/**
 * Get phone number details to test connection.
 */
export async function testWhatsAppConnection(
  config: WhatsAppConfig,
): Promise<{ ok: boolean; displayPhoneNumber: string; qualityRating: string }> {
  const res = await fetch(
    `${WA_API_BASE}/${config.phoneNumberId}?fields=display_phone_number,quality_rating`,
    { headers: { Authorization: `Bearer ${config.accessToken}` } },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp connection test failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return {
    ok: true,
    displayPhoneNumber: data.display_phone_number ?? "",
    qualityRating: data.quality_rating ?? "",
  };
}
