/**
 * Zendesk Support API Client
 *
 * Create and manage support tickets.
 */

export interface ZendeskConfig {
  subdomain: string;
  email: string;
  apiToken: string;
}

function zdBase(config: ZendeskConfig): string {
  return `https://${config.subdomain}.zendesk.com/api/v2`;
}

function zdHeaders(config: ZendeskConfig): Record<string, string> {
  const credentials = Buffer.from(`${config.email}/token:${config.apiToken}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
  };
}

export type ZendeskTicketPriority = "urgent" | "high" | "normal" | "low";

export interface ZendeskTicketInput {
  subject: string;
  body: string;
  requesterEmail: string;
  requesterName?: string;
  priority?: ZendeskTicketPriority;
  tags?: string[];
  customFields?: Array<{ id: number; value: string }>;
}

/**
 * Create a support ticket.
 */
export async function createZendeskTicket(
  config: ZendeskConfig,
  input: ZendeskTicketInput,
): Promise<{ ticketId: number; url: string }> {
  const body = {
    ticket: {
      subject: input.subject,
      comment: { body: input.body },
      priority: input.priority ?? "normal",
      tags: input.tags ?? [],
      custom_fields: input.customFields ?? [],
      requester: {
        email: input.requesterEmail,
        name: input.requesterName ?? input.requesterEmail,
      },
    },
  };

  const res = await fetch(`${zdBase(config)}/tickets.json`, {
    method: "POST",
    headers: zdHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Zendesk create ticket failed: ${err?.description ?? res.status}`);
  }

  const data: any = await res.json();
  const ticket = data.ticket;
  return {
    ticketId: ticket.id,
    url: `https://${config.subdomain}.zendesk.com/agent/tickets/${ticket.id}`,
  };
}

/**
 * Update a ticket (add comment, change status).
 */
export async function updateZendeskTicket(
  config: ZendeskConfig,
  ticketId: number,
  updates: { comment?: string; status?: "open" | "pending" | "solved" | "closed"; tags?: string[] },
): Promise<void> {
  const body: any = { ticket: {} };
  if (updates.comment) body.ticket.comment = { body: updates.comment };
  if (updates.status) body.ticket.status = updates.status;
  if (updates.tags) body.ticket.tags = updates.tags;

  const res = await fetch(`${zdBase(config)}/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: zdHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Zendesk update ticket failed: ${err?.description ?? res.status}`);
  }
}

/**
 * List recent tickets.
 */
export async function listZendeskTickets(
  config: ZendeskConfig,
  status = "open",
  perPage = 25,
): Promise<Array<{ id: number; subject: string; status: string; priority: string }>> {
  const res = await fetch(
    `${zdBase(config)}/tickets.json?status=${status}&per_page=${perPage}`,
    { headers: zdHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`Zendesk list tickets failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.tickets ?? []).map((t: any) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
  }));
}

/**
 * Test Zendesk connection.
 */
export async function testZendeskConnection(
  config: ZendeskConfig,
): Promise<{ ok: boolean; name: string; subdomain: string }> {
  const res = await fetch(`${zdBase(config)}/users/me.json`, {
    headers: zdHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Zendesk connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, name: data.user?.name ?? "", subdomain: config.subdomain };
}
