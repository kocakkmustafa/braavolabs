/**
 * BRA-P1-03-N1 — tenant repository allowlist: input rules. PURE (no I/O).
 *
 * The allowlist only RECORDS which repositories a tenant may later point read-only access at. Nothing here (or in
 * the router) talks to GitHub, stores a token or key, or grants access: the GitHub App (id, private key,
 * installation) is the founder's and never appears in code, env examples or the database. `installationId` is the
 * App's public numeric installation id, not a secret.
 *
 * Fail-closed grammar: only characters GitHub itself allows are accepted, so a stored value can never smuggle a
 * path, URL, flag, whitespace or control/bidi character into a later API call or log line.
 */

export const MAX_REPOS_PER_TENANT = 200;

/** GitHub login: 1-39 chars, alphanumerics and single hyphens, not starting/ending with a hyphen. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repository name: GitHub's own set; "." / ".." and a trailing ".git" are not repository names. */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const INSTALLATION_RE = /^[0-9]{1,15}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function isValidOwner(v: unknown): v is string {
  return typeof v === "string" && OWNER_RE.test(v);
}

export function isValidRepo(v: unknown): v is string {
  return typeof v === "string" && REPO_RE.test(v) && v !== "." && v !== ".." && !/\.git$/i.test(v);
}

export function isValidInstallationId(v: unknown): v is string {
  return typeof v === "string" && INSTALLATION_RE.test(v) && !/^0+$/.test(v);
}

/** Git ref name subset: no `..`, `//`, `@{`, trailing `/`, `.` or `.lock`, no leading `-` (flag injection). */
export function isValidBranch(v: unknown): v is string {
  return (
    typeof v === "string" &&
    BRANCH_RE.test(v) &&
    !v.includes("..") &&
    !v.includes("//") &&
    !v.includes("@{") &&
    !v.endsWith("/") &&
    !v.endsWith(".") &&
    !v.endsWith(".lock")
  );
}

/** Case-insensitive identity (GitHub treats owner/repo case-insensitively): the unique key. */
export function repoFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}
