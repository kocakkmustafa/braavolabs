/**
 * Calendly API v2 Client
 *
 * Manage event types and retrieve scheduled events.
 */

export interface CalendlyConfig {
  personalAccessToken: string;
}

const CALENDLY_API_BASE = "https://api.calendly.com";

function calendlyHeaders(config: CalendlyConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.personalAccessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Get the current user's info (includes organization URI).
 */
export async function getCalendlyCurrentUser(
  config: CalendlyConfig,
): Promise<{ uri: string; name: string; email: string; organizationUri: string }> {
  const res = await fetch(`${CALENDLY_API_BASE}/users/me`, {
    headers: calendlyHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Calendly get user failed: ${res.status}`);
  }

  const data: any = await res.json();
  const r = data.resource;
  return {
    uri: r.uri,
    name: r.name,
    email: r.email,
    organizationUri: r.current_organization,
  };
}

/**
 * List event types for a user.
 */
export async function listCalendlyEventTypes(
  config: CalendlyConfig,
  userUri: string,
): Promise<Array<{ uri: string; name: string; slug: string; durationMinutes: number; schedulingUrl: string }>> {
  const url = new URL(`${CALENDLY_API_BASE}/event_types`);
  url.searchParams.set("user", userUri);
  url.searchParams.set("active", "true");

  const res = await fetch(url.toString(), {
    headers: calendlyHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Calendly list event types failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.collection ?? []).map((et: any) => ({
    uri: et.uri,
    name: et.name,
    slug: et.slug,
    durationMinutes: et.duration,
    schedulingUrl: et.scheduling_url,
  }));
}

/**
 * List scheduled events for a user.
 */
export async function listCalendlyEvents(
  config: CalendlyConfig,
  userUri: string,
  minStartTime?: string,
  maxStartTime?: string,
  count = 20,
): Promise<Array<{ uri: string; name: string; startTime: string; endTime: string; status: string }>> {
  const url = new URL(`${CALENDLY_API_BASE}/scheduled_events`);
  url.searchParams.set("user", userUri);
  url.searchParams.set("count", String(count));
  if (minStartTime) url.searchParams.set("min_start_time", minStartTime);
  if (maxStartTime) url.searchParams.set("max_start_time", maxStartTime);
  url.searchParams.set("sort", "start_time:asc");

  const res = await fetch(url.toString(), {
    headers: calendlyHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Calendly list events failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.collection ?? []).map((e: any) => ({
    uri: e.uri,
    name: e.name,
    startTime: e.start_time,
    endTime: e.end_time,
    status: e.status,
  }));
}

/**
 * Cancel a scheduled event.
 */
export async function cancelCalendlyEvent(
  config: CalendlyConfig,
  eventUuid: string,
  reason?: string,
): Promise<void> {
  const res = await fetch(`${CALENDLY_API_BASE}/scheduled_events/${eventUuid}/cancellation`, {
    method: "POST",
    headers: calendlyHeaders(config),
    body: JSON.stringify({ reason: reason ?? "Cancelled via API" }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Calendly cancel event failed: ${err?.message ?? res.status}`);
  }
}

/**
 * Test Calendly connection.
 */
export async function testCalendlyConnection(
  config: CalendlyConfig,
): Promise<{ ok: boolean; name: string; email: string }> {
  const user = await getCalendlyCurrentUser(config);
  return { ok: true, name: user.name, email: user.email };
}
