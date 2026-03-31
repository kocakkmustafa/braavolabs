/**
 * WordPress REST API Client
 *
 * Create and manage WordPress posts and pages.
 * Uses Application Passwords for authentication.
 */

export interface WordPressConfig {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

function wpBase(config: WordPressConfig): string {
  return `${config.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2`;
}

function wpHeaders(config: WordPressConfig): Record<string, string> {
  const credentials = Buffer.from(
    `${config.username}:${config.applicationPassword}`,
  ).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
  };
}

export type WPPostStatus = "publish" | "draft" | "pending" | "private";

export interface WPPostInput {
  title: string;
  content: string;
  status?: WPPostStatus;
  categories?: number[];
  tags?: number[];
  excerpt?: string;
  slug?: string;
}

/**
 * Create a new WordPress post.
 */
export async function createWordPressPost(
  config: WordPressConfig,
  post: WPPostInput,
): Promise<{ postId: number; link: string; slug: string }> {
  const res = await fetch(`${wpBase(config)}/posts`, {
    method: "POST",
    headers: wpHeaders(config),
    body: JSON.stringify(post),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`WordPress create post failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { postId: data.id, link: data.link, slug: data.slug };
}

/**
 * Update an existing WordPress post.
 */
export async function updateWordPressPost(
  config: WordPressConfig,
  postId: number,
  updates: Partial<WPPostInput>,
): Promise<void> {
  const res = await fetch(`${wpBase(config)}/posts/${postId}`, {
    method: "POST",
    headers: wpHeaders(config),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`WordPress update post failed: ${err?.message ?? res.status}`);
  }
}

/**
 * List recent posts.
 */
export async function listWordPressPosts(
  config: WordPressConfig,
  perPage = 10,
  status: WPPostStatus = "publish",
): Promise<Array<{ id: number; title: string; link: string; status: string }>> {
  const res = await fetch(
    `${wpBase(config)}/posts?per_page=${perPage}&status=${status}`,
    { headers: wpHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`WordPress list posts failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data ?? []).map((p: any) => ({
    id: p.id,
    title: p.title?.rendered ?? "",
    link: p.link,
    status: p.status,
  }));
}

/**
 * Test WordPress connection by fetching site info.
 */
export async function testWordPressConnection(
  config: WordPressConfig,
): Promise<{ ok: boolean; siteName: string; url: string }> {
  const res = await fetch(
    `${config.siteUrl.replace(/\/$/, "")}/wp-json`,
    { headers: wpHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`WordPress connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, siteName: data.name ?? "", url: data.url ?? "" };
}
