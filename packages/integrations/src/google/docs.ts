/**
 * Google Docs API Client
 *
 * Create and edit Google Documents using OAuth2.
 */

export interface GoogleDocsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCS_API_BASE = "https://docs.googleapis.com/v1";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

async function getAccessToken(config: GoogleDocsConfig): Promise<string> {
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

/**
 * Create a new Google Doc.
 */
export async function createGoogleDoc(
  config: GoogleDocsConfig,
  title: string,
): Promise<{ documentId: string; title: string; url: string }> {
  const token = await getAccessToken(config);

  const res = await fetch(`${DOCS_API_BASE}/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Docs create failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return {
    documentId: data.documentId,
    title: data.title,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
  };
}

/**
 * Append text content to an existing document.
 */
export async function appendToGoogleDoc(
  config: GoogleDocsConfig,
  documentId: string,
  text: string,
): Promise<void> {
  const token = await getAccessToken(config);

  const res = await fetch(`${DOCS_API_BASE}/documents/${documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Docs append failed: ${err?.error?.message ?? res.status}`);
  }
}

/**
 * Get document content.
 */
export async function getGoogleDoc(
  config: GoogleDocsConfig,
  documentId: string,
): Promise<{ title: string; content: string }> {
  const token = await getAccessToken(config);

  const res = await fetch(`${DOCS_API_BASE}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Google Docs get failed: ${res.status}`);
  }

  const data: any = await res.json();
  const text = (data.body?.content ?? [])
    .flatMap((el: any) => el.paragraph?.elements ?? [])
    .map((el: any) => el.textRun?.content ?? "")
    .join("");

  return { title: data.title, content: text };
}

/**
 * Test Google Docs connection.
 */
export async function testGoogleDocsConnection(
  config: GoogleDocsConfig,
): Promise<{ ok: boolean; email: string }> {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${DRIVE_API_BASE}/about?fields=user`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    throw new Error(`Google Docs connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, email: data.user?.emailAddress ?? "" };
}
