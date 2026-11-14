import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGitHubPRStatus,
  getGitHubBranchStatus,
  listGitHubPRs,
  dryRunGitHubPR,
  type GitHubConfig,
} from "../github";

const config: GitHubConfig = { personalAccessToken: "ghp_test_token_123" };

/**
 * Build a Response-like stub good enough for the github.ts read helpers,
 * which only touch `res.ok`, `res.status`, and `res.json()`.
 */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

describe("github read helpers (E3 T4)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("getGitHubPRStatus", () => {
    it("hits the pulls/{n} endpoint with auth + api-version headers and parses the shape", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          number: 28,
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "feat/e3-handoff", sha: "abc123" },
          base: { ref: "main" },
          changed_files: 4,
          additions: 120,
          deletions: 12,
          html_url: "https://github.com/kocakkmustafa/braavolabs/pull/28",
        }),
      );

      const result = await getGitHubPRStatus(config, "kocakkmustafa", "braavolabs", 28);

      // URL
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.github.com/repos/kocakkmustafa/braavolabs/pulls/28");
      // Headers reuse githubHeaders (Bearer + api-version 2022-11-28)
      expect(opts.headers.Authorization).toBe("Bearer ghp_test_token_123");
      expect(opts.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(opts.headers.Accept).toBe("application/vnd.github+json");
      expect(opts.method).toBeUndefined(); // read = GET (no method)

      // Parse
      expect(result).toEqual({
        number: 28,
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        headRef: "feat/e3-handoff",
        headSha: "abc123",
        baseRef: "main",
        changedFiles: 4,
        additions: 120,
        deletions: 12,
        url: "https://github.com/kocakkmustafa/braavolabs/pull/28",
      });
    });

    it("coerces a still-computing mergeable=null to null (not false)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          number: 5,
          state: "open",
          merged: false,
          mergeable: null,
          mergeable_state: "unknown",
          head: { ref: "wip", sha: "deadbeef" },
          base: { ref: "main" },
          changed_files: 1,
          additions: 1,
          deletions: 0,
          html_url: "https://x/pull/5",
        }),
      );

      const result = await getGitHubPRStatus(config, "o", "r", 5);
      expect(result.mergeable).toBeNull();
      expect(result.mergeableState).toBe("unknown");
    });

    it("throws with the status code on a non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { ok: false, status: 404 }));
      await expect(getGitHubPRStatus(config, "o", "r", 999)).rejects.toThrow(/404/);
    });
  });

  describe("getGitHubBranchStatus", () => {
    it("calls compare then branch, and merges ahead/behind + head sha", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ status: "ahead", ahead_by: 3, behind_by: 0 }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ name: "feat/e3-handoff", commit: { sha: "cafe1234" } }),
        );

      const result = await getGitHubBranchStatus(config, "kocakkmustafa", "braavolabs", "feat/e3-handoff", "main");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // First call: compare base...branch
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/kocakkmustafa/braavolabs/compare/main...feat/e3-handoff",
      );
      // Second call: branch head sha
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://api.github.com/repos/kocakkmustafa/braavolabs/branches/feat/e3-handoff",
      );
      // Both authed with api-version
      for (const call of fetchMock.mock.calls) {
        expect(call[1].headers.Authorization).toBe("Bearer ghp_test_token_123");
        expect(call[1].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      }

      expect(result).toEqual({
        name: "feat/e3-handoff",
        headSha: "cafe1234",
        aheadBy: 3,
        behindBy: 0,
        status: "ahead",
      });
    });

    it("defaults base to main when not provided", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: "identical", ahead_by: 0, behind_by: 0 }))
        .mockResolvedValueOnce(jsonResponse({ name: "topic", commit: { sha: "s" } }));

      await getGitHubBranchStatus(config, "o", "r", "topic");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/o/r/compare/main...topic");
    });

    it("throws when the compare call fails (no second call made)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { ok: false, status: 404 }));
      await expect(getGitHubBranchStatus(config, "o", "r", "ghost")).rejects.toThrow(/compare.*404/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws when the branch call fails after a successful compare", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: "ahead", ahead_by: 1, behind_by: 0 }))
        .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { ok: false, status: 404 }));
      await expect(getGitHubBranchStatus(config, "o", "r", "ghost")).rejects.toThrow(/branch.*404/i);
    });
  });

  describe("listGitHubPRs", () => {
    it("lists open PRs by default and maps head ref + url", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            number: 28,
            title: "handoff ledger",
            state: "open",
            head: { ref: "feat/e3-handoff" },
            html_url: "https://x/pull/28",
          },
          {
            number: 27,
            title: "compose fix",
            state: "open",
            head: { ref: "fix/compose" },
            html_url: "https://x/pull/27",
          },
        ]),
      );

      const result = await listGitHubPRs(config, "kocakkmustafa", "braavolabs");

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/kocakkmustafa/braavolabs/pulls?state=open&per_page=30",
      );
      expect(fetchMock.mock.calls[0][1].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(result).toEqual([
        { number: 28, title: "handoff ledger", state: "open", headRef: "feat/e3-handoff", url: "https://x/pull/28" },
        { number: 27, title: "compose fix", state: "open", headRef: "fix/compose", url: "https://x/pull/27" },
      ]);
    });

    it("passes an explicit state through to the query string", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await listGitHubPRs(config, "o", "r", "all");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/o/r/pulls?state=all&per_page=30");
    });

    it("tolerates a null body (returns [])", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(null));
      const result = await listGitHubPRs(config, "o", "r");
      expect(result).toEqual([]);
    });

    it("throws with the status code on a non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Bad creds" }, { ok: false, status: 401 }));
      await expect(listGitHubPRs(config, "o", "r")).rejects.toThrow(/401/);
    });
  });
});

describe("dryRunGitHubPR (BRA-P1-03a)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the would-be request without calling fetch and without token/headers", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = dryRunGitHubPR("o", "r", "T", "B", "feat/x", "main", true);
    expect(out.dryRun).toBe(true);
    expect(out.request.method).toBe("POST");
    expect(out.request.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(out.request.body).toEqual({ title: "T", body: "B", head: "feat/x", base: "main", draft: true });
    expect(Object.keys(out.request.body)).toEqual(["title", "body", "head", "base", "draft"]);
    expect(JSON.stringify(out)).not.toMatch(/ghp_|authorization|headers/i);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("defaults draft to false", () => {
    expect(dryRunGitHubPR("o", "r", "T", "", "h", "main").request.body.draft).toBe(false);
  });

  it.each([
    ["owner ..", ["..", "r", "T", "B", "h", "main"]],
    ["owner .", [".", "r", "T", "B", "h", "main"]],
    ["owner slash", ["a/b", "r", "T", "B", "h", "main"]],
    ["repo empty", ["o", "", "T", "B", "h", "main"]],
    ["empty title", ["o", "r", "  ", "B", "h", "main"]],
    ["long title", ["o", "r", "x".repeat(257), "B", "h", "main"]],
    ["control char title", ["o", "r", "a\nb", "B", "h", "main"]],
    ["empty head", ["o", "r", "T", "B", "", "main"]],
    ["control char base", ["o", "r", "T", "B", "h", "ma\u0000in"]],
  ] as const)("rejects invalid input: %s", (_n, a) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => (dryRunGitHubPR as any)(...a)).toThrow(/invalid/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
