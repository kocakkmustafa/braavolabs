/**
 * GitHub REST API Client
 *
 * Create issues, pull requests, and manage repositories.
 */

export interface GitHubConfig {
  personalAccessToken: string;
  defaultOwner?: string;
}

const GITHUB_API_BASE = "https://api.github.com";

function githubHeaders(config: GitHubConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.personalAccessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

interface GitHubErrorBody {
  message?: string;
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
}

interface GitHubPullResponse {
  number: number;
  html_url: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  pull_request?: unknown;
}

interface GitHubCommentResponse {
  id: number;
}

interface GitHubUserResponse {
  login: string;
  name?: string | null;
}

/**
 * Create a GitHub issue.
 */
export async function createGitHubIssue(
  config: GitHubConfig,
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels?: string[],
  assignees?: string[],
): Promise<{ issueNumber: number; url: string }> {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: githubHeaders(config),
    body: JSON.stringify({ title, body, labels, assignees }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as GitHubErrorBody;
    throw new Error(`GitHub create issue failed: ${err?.message ?? res.status}`);
  }

  const data = (await res.json()) as GitHubIssueResponse;
  return { issueNumber: data.number, url: data.html_url };
}

/**
 * Create a pull request.
 */
export async function createGitHubPR(
  config: GitHubConfig,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft = false,
): Promise<{ prNumber: number; url: string }> {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: githubHeaders(config),
    body: JSON.stringify({ title, body, head, base, draft }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as GitHubErrorBody;
    throw new Error(`GitHub create PR failed: ${err?.message ?? res.status}`);
  }

  const data = (await res.json()) as GitHubPullResponse;
  return { prNumber: data.number, url: data.html_url };
}

/**
 * List open issues in a repository.
 */
export async function listGitHubIssues(
  config: GitHubConfig,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open",
  perPage = 30,
): Promise<Array<{ number: number; title: string; state: string; url: string }>> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`,
    { headers: githubHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`GitHub list issues failed: ${res.status}`);
  }

  const data = (await res.json()) as GitHubIssueListItem[] | null;
  return (data ?? [])
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
    }));
}

/**
 * Add a comment to an issue or PR.
 */
export async function addGitHubComment(
  config: GitHubConfig,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ commentId: number }> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: githubHeaders(config),
      body: JSON.stringify({ body }),
    },
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as GitHubErrorBody;
    throw new Error(`GitHub add comment failed: ${err?.message ?? res.status}`);
  }

  const data = (await res.json()) as GitHubCommentResponse;
  return { commentId: data.id };
}

/**
 * Test GitHub connection.
 */
export async function testGitHubConnection(
  config: GitHubConfig,
): Promise<{ ok: boolean; login: string; name: string }> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: githubHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`GitHub connection test failed: ${res.status}`);
  }

  const data = (await res.json()) as GitHubUserResponse;
  return { ok: true, login: data.login, name: data.name ?? data.login };
}
