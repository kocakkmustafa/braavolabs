/**
 * Intercom API Client
 *
 * Manage contacts, conversations, and messages.
 */

export interface IntercomConfig {
  accessToken: string;
}

const INTERCOM_API_BASE = "https://api.intercom.io";

function intercomHeaders(config: IntercomConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Intercom-Version": "2.11",
  };
}

/**
 * Create or update a contact (lead/user).
 */
export async function upsertIntercomContact(
  config: IntercomConfig,
  email: string,
  name?: string,
  customAttributes?: Record<string, unknown>,
): Promise<{ contactId: string; type: string }> {
  const body: any = { email };
  if (name) body.name = name;
  if (customAttributes) body.custom_attributes = customAttributes;

  const res = await fetch(`${INTERCOM_API_BASE}/contacts/merge`, {
    method: "POST",
    headers: intercomHeaders(config),
    body: JSON.stringify(body),
  });

  // Fallback: try creating contact directly
  const createRes = await fetch(`${INTERCOM_API_BASE}/contacts`, {
    method: "POST",
    headers: intercomHeaders(config),
    body: JSON.stringify({ ...body, role: "lead" }),
  });

  if (!createRes.ok) {
    const err: any = await createRes.json().catch(() => ({}));
    throw new Error(`Intercom upsert contact failed: ${err?.errors?.[0]?.message ?? createRes.status}`);
  }

  const data: any = await createRes.json();
  return { contactId: data.id, type: data.role };
}

/**
 * Search contacts by email.
 */
export async function searchIntercomContacts(
  config: IntercomConfig,
  email: string,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const res = await fetch(`${INTERCOM_API_BASE}/contacts/search`, {
    method: "POST",
    headers: intercomHeaders(config),
    body: JSON.stringify({
      query: {
        field: "email",
        operator: "=",
        value: email,
      },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Intercom search contacts failed: ${err?.errors?.[0]?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return (data.data ?? []).map((c: any) => ({
    id: c.id,
    email: c.email ?? "",
    name: c.name ?? "",
  }));
}

/**
 * Send a message to a contact (outbound conversation).
 */
export async function sendIntercomMessage(
  config: IntercomConfig,
  contactId: string,
  message: string,
  adminId: string,
): Promise<{ conversationId: string }> {
  const res = await fetch(`${INTERCOM_API_BASE}/messages`, {
    method: "POST",
    headers: intercomHeaders(config),
    body: JSON.stringify({
      message_type: "outbound",
      subject: "",
      body: message,
      template: "plain",
      from: { type: "admin", id: adminId },
      to: { type: "contact", id: contactId },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Intercom send message failed: ${err?.errors?.[0]?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { conversationId: data.conversation_id ?? data.id };
}

/**
 * Test Intercom connection.
 */
export async function testIntercomConnection(
  config: IntercomConfig,
): Promise<{ ok: boolean; appId: string; name: string }> {
  const res = await fetch(`${INTERCOM_API_BASE}/me`, {
    headers: intercomHeaders(config),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Intercom connection test failed: ${err?.errors?.[0]?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, appId: data.app?.id_code ?? "", name: data.name ?? "" };
}
