/**
 * Google Sheets API Client
 *
 * Read and write Google Spreadsheets using OAuth2.
 */

export interface GoogleSheetsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";

async function getAccessToken(config: GoogleSheetsConfig): Promise<string> {
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
 * Read values from a range in a spreadsheet.
 */
export async function readGoogleSheet(
  config: GoogleSheetsConfig,
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Sheets read failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return data.values ?? [];
}

/**
 * Write values to a range in a spreadsheet (overwrites).
 */
export async function writeGoogleSheet(
  config: GoogleSheetsConfig,
  spreadsheetId: string,
  range: string,
  values: (string | number | boolean)[][],
): Promise<{ updatedRows: number; updatedCells: number }> {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Sheets write failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return {
    updatedRows: data.updatedRows ?? 0,
    updatedCells: data.updatedCells ?? 0,
  };
}

/**
 * Append rows to a spreadsheet.
 */
export async function appendGoogleSheet(
  config: GoogleSheetsConfig,
  spreadsheetId: string,
  range: string,
  values: (string | number | boolean)[][],
): Promise<{ updatedRows: number }> {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ majorDimension: "ROWS", values }),
    },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Google Sheets append failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { updatedRows: data.updates?.updatedRows ?? 0 };
}

/**
 * Test Google Sheets connection by fetching spreadsheet metadata.
 */
export async function testGoogleSheetsConnection(
  config: GoogleSheetsConfig,
): Promise<{ ok: boolean }> {
  const token = await getAccessToken(config);

  const res = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user",
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    throw new Error(`Google Sheets connection test failed: ${res.status}`);
  }

  return { ok: true };
}
