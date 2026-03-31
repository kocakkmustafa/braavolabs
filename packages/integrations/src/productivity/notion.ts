/**
 * Notion API Client
 *
 * Create and manage Notion pages and database entries.
 */

export interface NotionConfig {
  apiKey: string;
}

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function notionHeaders(config: NotionConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

/**
 * Create a new page in a Notion parent (page or database).
 */
export async function createNotionPage(
  config: NotionConfig,
  parentId: string,
  parentType: "page_id" | "database_id",
  title: string,
  properties?: Record<string, unknown>,
  content?: string,
): Promise<{ pageId: string; url: string }> {
  const parent = parentType === "database_id"
    ? { database_id: parentId }
    : { page_id: parentId };

  const titleProperty = parentType === "database_id"
    ? { Name: { title: [{ text: { content: title } }] }, ...properties }
    : undefined;

  const children = content
    ? [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content } }] },
        },
      ]
    : undefined;

  const body: any = { parent };
  if (titleProperty) {
    body.properties = titleProperty;
  } else {
    body.properties = {
      title: [{ text: { content: title } }],
      ...properties,
    };
  }
  if (children) body.children = children;

  const res = await fetch(`${NOTION_API_BASE}/pages`, {
    method: "POST",
    headers: notionHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Notion create page failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { pageId: data.id, url: data.url };
}

/**
 * Query a Notion database.
 */
export async function queryNotionDatabase(
  config: NotionConfig,
  databaseId: string,
  filter?: unknown,
  pageSize = 50,
): Promise<Array<{ id: string; url: string; properties: unknown }>> {
  const res = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
    method: "POST",
    headers: notionHeaders(config),
    body: JSON.stringify({ filter, page_size: pageSize }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Notion query database failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return (data.results ?? []).map((p: any) => ({
    id: p.id,
    url: p.url,
    properties: p.properties,
  }));
}

/**
 * Update a Notion page's properties.
 */
export async function updateNotionPage(
  config: NotionConfig,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(config),
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Notion update page failed: ${err?.message ?? res.status}`);
  }
}

/**
 * Test Notion connection by fetching the authenticated user.
 */
export async function testNotionConnection(
  config: NotionConfig,
): Promise<{ ok: boolean; name: string }> {
  const res = await fetch(`${NOTION_API_BASE}/users/me`, {
    headers: notionHeaders(config),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Notion connection test failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, name: data.name ?? data.bot?.owner?.workspace_name ?? "" };
}
