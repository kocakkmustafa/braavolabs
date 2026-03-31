/**
 * Airtable API Client
 *
 * Read and write Airtable bases and records.
 */

export interface AirtableConfig {
  apiKey: string;
  baseId?: string;
}

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

function airtableHeaders(config: AirtableConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * List records from a table.
 */
export async function listAirtableRecords(
  config: AirtableConfig,
  baseId: string,
  tableName: string,
  maxRecords = 100,
  filterFormula?: string,
): Promise<Array<{ id: string; fields: Record<string, unknown>; createdTime: string }>> {
  const url = new URL(`${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}`);
  url.searchParams.set("maxRecords", String(maxRecords));
  if (filterFormula) url.searchParams.set("filterByFormula", filterFormula);

  const res = await fetch(url.toString(), { headers: airtableHeaders(config) });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Airtable list records failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return (data.records ?? []).map((r: any) => ({
    id: r.id,
    fields: r.fields,
    createdTime: r.createdTime,
  }));
}

/**
 * Create a new record in a table.
 */
export async function createAirtableRecord(
  config: AirtableConfig,
  baseId: string,
  tableName: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; fields: Record<string, unknown> }> {
  const res = await fetch(
    `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}`,
    {
      method: "POST",
      headers: airtableHeaders(config),
      body: JSON.stringify({ fields }),
    },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Airtable create record failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { id: data.id, fields: data.fields };
}

/**
 * Update an existing record.
 */
export async function updateAirtableRecord(
  config: AirtableConfig,
  baseId: string,
  tableName: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`,
    {
      method: "PATCH",
      headers: airtableHeaders(config),
      body: JSON.stringify({ fields }),
    },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Airtable update record failed: ${err?.error?.message ?? res.status}`);
  }
}

/**
 * Delete a record.
 */
export async function deleteAirtableRecord(
  config: AirtableConfig,
  baseId: string,
  tableName: string,
  recordId: string,
): Promise<void> {
  const res = await fetch(
    `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`,
    {
      method: "DELETE",
      headers: airtableHeaders(config),
    },
  );

  if (!res.ok) {
    throw new Error(`Airtable delete record failed: ${res.status}`);
  }
}

/**
 * Test Airtable connection by listing bases.
 */
export async function testAirtableConnection(
  config: AirtableConfig,
): Promise<{ ok: boolean; bases: string[] }> {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: airtableHeaders(config),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Airtable connection test failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  const bases = (data.bases ?? []).map((b: any) => b.name);
  return { ok: true, bases };
}
