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

// ─── Read-only status shapes (E3 T4 — handoff git-awareness) ───

interface GitHubPullDetailResponse {
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  changed_files: number;
  additions: number;
  deletions: number;
  html_url: string;
}

interface GitHubCompareResponse {
  status: string; // "ahead" | "behind" | "identical" | "diverged"
  ahead_by: number;
  behind_by: number;
}

interface GitHubBranchResponse {
  name: string;
  commit: { sha: string };
}

interface GitHubPullListItem {
  number: number;
  title: string;
  state: string;
  head: { ref: string };
  html_url: string;
}

/**
 * Read the status of a single pull request.
 *
 * GET /repos/{owner}/{repo}/pulls/{prNumber}
 *
 * Read-only; used by the handoff ledger's git-awareness snapshot and by the
 * `get_github_pr_status` agent tool. `mergeable` is `null` while GitHub is
 * still computing the merge (the caller should treat null as "unknown").
 */
export async function getGitHubPRStatus(
  config: GitHubConfig,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  url: string;
}> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: githubHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`GitHub get PR status failed: ${res.status}`);
  }

  const data = (await res.json()) as GitHubPullDetailResponse;
  return {
    number: data.number,
    state: data.state,
    merged: data.merged ?? false,
    mergeable: data.mergeable ?? null,
    mergeableState: data.mergeable_state ?? "unknown",
    headRef: data.head?.ref ?? "",
    headSha: data.head?.sha ?? "",
    baseRef: data.base?.ref ?? "",
    changedFiles: data.changed_files ?? 0,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    url: data.html_url,
  };
}

/**
 * Read a branch's position relative to a base branch (ahead/behind) plus its
 * head SHA.
 *
 * GET /repos/{owner}/{repo}/compare/{base}...{branch}  (ahead/behind + status)
 * GET /repos/{owner}/{repo}/branches/{branch}          (head SHA)
 *
 * Read-only; used by the handoff ledger snapshot and by the
 * `get_github_branch_status` agent tool.
 */
export async function getGitHubBranchStatus(
  config: GitHubConfig,
  owner: string,
  repo: string,
  branch: string,
  base = "main",
): Promise<{
  name: string;
  headSha: string;
  aheadBy: number;
  behindBy: number;
  status: string;
}> {
  const compareRes = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${base}...${branch}`,
    { headers: githubHeaders(config) },
  );

  if (!compareRes.ok) {
    throw new Error(`GitHub compare branch failed: ${compareRes.status}`);
  }

  const compare = (await compareRes.json()) as GitHubCompareResponse;

  const branchRes = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches/${branch}`,
    { headers: githubHeaders(config) },
  );

  if (!branchRes.ok) {
    throw new Error(`GitHub get branch failed: ${branchRes.status}`);
  }

  const branchData = (await branchRes.json()) as GitHubBranchResponse;

  return {
    name: branchData.name ?? branch,
    headSha: branchData.commit?.sha ?? "",
    aheadBy: compare.ahead_by ?? 0,
    behindBy: compare.behind_by ?? 0,
    status: compare.status ?? "unknown",
  };
}

/**
 * List pull requests in a repository (open by default).
 *
 * GET /repos/{owner}/{repo}/pulls?state={state}
 *
 * Read-only; used by the handoff ledger snapshot when no specific PR number is
 * known.
 */
export async function listGitHubPRs(
  config: GitHubConfig,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open",
  perPage = 30,
): Promise<Array<{ number: number; title: string; state: string; headRef: string; url: string }>> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
    { headers: githubHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`GitHub list PRs failed: ${res.status}`);
  }

  const data = (await res.json()) as GitHubPullListItem[] | null;
  return (data ?? []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    headRef: pr.head?.ref ?? "",
    url: pr.html_url,
  }));
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
