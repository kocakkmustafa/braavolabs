/**
 * Trello REST API Client
 *
 * Create and manage cards on Trello boards.
 */

export interface TrelloConfig {
  apiKey: string;
  token: string;
}

const TRELLO_API_BASE = "https://api.trello.com/1";

function trelloAuth(config: TrelloConfig): string {
  return `key=${config.apiKey}&token=${config.token}`;
}

/**
 * Get boards for the authenticated user.
 */
export async function listTrelloBoards(
  config: TrelloConfig,
): Promise<Array<{ id: string; name: string; url: string }>> {
  const res = await fetch(`${TRELLO_API_BASE}/members/me/boards?${trelloAuth(config)}`);

  if (!res.ok) {
    throw new Error(`Trello list boards failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data ?? []).map((b: any) => ({ id: b.id, name: b.name, url: b.url }));
}

/**
 * Get lists on a board.
 */
export async function listTrelloLists(
  config: TrelloConfig,
  boardId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(
    `${TRELLO_API_BASE}/boards/${boardId}/lists?${trelloAuth(config)}`,
  );

  if (!res.ok) {
    throw new Error(`Trello list lists failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data ?? []).map((l: any) => ({ id: l.id, name: l.name }));
}

/**
 * Create a card on a list.
 */
export async function createTrelloCard(
  config: TrelloConfig,
  listId: string,
  name: string,
  desc?: string,
  due?: string,
  labelIds?: string[],
): Promise<{ cardId: string; url: string }> {
  const params = new URLSearchParams({
    idList: listId,
    name,
    ...(desc ? { desc } : {}),
    ...(due ? { due } : {}),
    ...(labelIds?.length ? { idLabels: labelIds.join(",") } : {}),
  });

  const res = await fetch(`${TRELLO_API_BASE}/cards?${trelloAuth(config)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Trello create card failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { cardId: data.id, url: data.url };
}

/**
 * Update a card.
 */
export async function updateTrelloCard(
  config: TrelloConfig,
  cardId: string,
  updates: {
    name?: string;
    desc?: string;
    due?: string | null;
    idList?: string;
    closed?: boolean;
  },
): Promise<void> {
  const params = new URLSearchParams(
    Object.fromEntries(
      Object.entries(updates)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ),
  );

  const res = await fetch(`${TRELLO_API_BASE}/cards/${cardId}?${trelloAuth(config)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Trello update card failed: ${res.status}`);
  }
}

/**
 * Add a comment to a card.
 */
export async function addTrelloComment(
  config: TrelloConfig,
  cardId: string,
  text: string,
): Promise<void> {
  const res = await fetch(
    `${TRELLO_API_BASE}/cards/${cardId}/actions/comments?${trelloAuth(config)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text }).toString(),
    },
  );

  if (!res.ok) {
    throw new Error(`Trello add comment failed: ${res.status}`);
  }
}

/**
 * Test Trello connection.
 */
export async function testTrelloConnection(
  config: TrelloConfig,
): Promise<{ ok: boolean; username: string; fullName: string }> {
  const res = await fetch(`${TRELLO_API_BASE}/members/me?${trelloAuth(config)}`);

  if (!res.ok) {
    throw new Error(`Trello connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, username: data.username, fullName: data.fullName };
}
