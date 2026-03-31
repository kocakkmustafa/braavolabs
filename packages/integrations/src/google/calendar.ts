/**
 * Google Calendar API Client
 *
 * Create and manage Google Calendar events using OAuth2.
 */

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

async function getAccessToken(config: GoogleCalendarConfig): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }

  const data: any = await res.json();
  return data.access_token;
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  attendees?: string[];
  location?: string;
  timeZone?: string;
}

/**
 * Create a calendar event.
 */
export async function createCalendarEvent(
  config: GoogleCalendarConfig,
  calendarId: string,
  event: CalendarEvent,
): Promise<{ eventId: string; htmlLink: string }> {
  const token = await getAccessToken(config);
  const tz = event.timeZone ?? "UTC";

  const body: any = {
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startDateTime, timeZone: tz },
    end: { dateTime: event.endDateTime, timeZone: tz },
  };

  if (event.attendees?.length) {
    body.attendees = event.attendees.map((email) => ({ email }));
  }

  const res = await fetch(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Calendar create event failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { eventId: data.id, htmlLink: data.htmlLink };
}

/**
 * List upcoming events.
 */
export async function listCalendarEvents(
  config: GoogleCalendarConfig,
  calendarId: string,
  maxResults = 10,
): Promise<Array<{ id: string; summary: string; start: string }>> {
  const token = await getAccessToken(config);
  const now = new Date().toISOString();

  const url = new URL(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("timeMin", now);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Google Calendar list events failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.items ?? []).map((e: any) => ({
    id: e.id,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
  }));
}

/**
 * Test Google Calendar connection.
 */
export async function testGoogleCalendarConnection(
  config: GoogleCalendarConfig,
): Promise<{ ok: boolean; calendarSummary: string }> {
  const token = await getAccessToken(config);

  const res = await fetch(`${CALENDAR_API_BASE}/calendars/primary`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Google Calendar connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, calendarSummary: data.summary ?? "primary" };
}
