/**
 * GitHub read-only agent tools (E3 T4) — registration + handler behaviour.
 *
 * Two READ-ONLY status tools (get_github_pr_status, get_github_branch_status)
 * canlanan github.ts okumalarına köprü kurar. Bunlar:
 *   • low-risk / approval'sız (read-only) kayıtlı olmalı,
 *   • GITHUB integration yoksa MISSING_INTEGRATION döndürmeli,
 *   • integration varsa doğru github.ts fonksiyonunu çağırıp COMPLETED dönmeli,
 *   • owner default'u credentials.defaultOwner'dan çözmeli.
 * Ağ yok — getActiveIntegration ve @ai-company-os/integrations mock'lanır.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before importing the SUT) ──

const getActiveIntegration = vi.hoisted(() => vi.fn());
vi.mock("../../integration/checker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration/checker")>();
  return { ...actual, getActiveIntegration };
});

const getGitHubPRStatus = vi.hoisted(() => vi.fn());
const getGitHubBranchStatus = vi.hoisted(() => vi.fn());
vi.mock("@ai-company-os/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-company-os/integrations")>();
  return { ...actual, getGitHubPRStatus, getGitHubBranchStatus };
});

import { getTool, getToolMeta } from "../registry";
import { TOOL_PROVIDER_MAP } from "../../integration/checker";

beforeEach(() => {
  getActiveIntegration.mockReset();
  getGitHubPRStatus.mockReset();
  getGitHubBranchStatus.mockReset();
});

describe("GitHub read tools — registration", () => {
  it("registers get_github_pr_status as read-only (approval:false, risk:low)", () => {
    expect(getTool("get_github_pr_status")).toBeDefined();
    const meta = getToolMeta("get_github_pr_status");
    expect(meta?.requiresApproval).toBe(false);
    expect(meta?.riskLevel).toBe("low");
    expect(meta?.moneyTouching).toBeUndefined();
  });

  it("registers get_github_branch_status as read-only (approval:false, risk:low)", () => {
    expect(getTool("get_github_branch_status")).toBeDefined();
    const meta = getToolMeta("get_github_branch_status");
    expect(meta?.requiresApproval).toBe(false);
    expect(meta?.riskLevel).toBe("low");
  });

  it("declares the required inputs", () => {
    const prSchema = getTool("get_github_pr_status")!.inputSchema as any;
    expect(prSchema.required).toEqual(expect.arrayContaining(["companyId", "prNumber", "repo"]));
    const brSchema = getTool("get_github_branch_status")!.inputSchema as any;
    expect(brSchema.required).toEqual(expect.arrayContaining(["companyId", "branch", "repo"]));
  });

  it("maps both tools to the GITHUB provider in checker's TOOL_PROVIDER_MAP", () => {
    expect(TOOL_PROVIDER_MAP.get_github_pr_status).toBe("GITHUB");
    expect(TOOL_PROVIDER_MAP.get_github_branch_status).toBe("GITHUB");
  });
});

describe("get_github_pr_status — handler", () => {
  it("returns MISSING_INTEGRATION when the tenant has no GITHUB integration", async () => {
    getActiveIntegration.mockResolvedValue(null);
    const out = (await getTool("get_github_pr_status")!.handler({
      companyId: "c1",
      prNumber: 28,
      repo: "braavolabs",
      owner: "kocakkmustafa",
    })) as any;
    expect(out.status).toBe("MISSING_INTEGRATION");
    expect(out.provider).toBe("GITHUB");
    expect(getGitHubPRStatus).not.toHaveBeenCalled();
  });

  it("calls getGitHubPRStatus with the resolved config and returns COMPLETED", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "kocakkmustafa" });
    getGitHubPRStatus.mockResolvedValue({ number: 28, state: "open", mergeable: true });

    const out = (await getTool("get_github_pr_status")!.handler({
      companyId: "c1",
      prNumber: 28,
      repo: "braavolabs",
    })) as any;

    expect(getActiveIntegration).toHaveBeenCalledWith("c1", "GITHUB");
    // owner falls back to credentials.defaultOwner when omitted
    expect(getGitHubPRStatus).toHaveBeenCalledWith(
      { personalAccessToken: "ghp_x", defaultOwner: "kocakkmustafa" },
      "kocakkmustafa",
      "braavolabs",
      28,
    );
    expect(out.status).toBe("COMPLETED");
    expect(out.pr.number).toBe(28);
  });

  it("prefers an explicit owner over the credentials default", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "default-org" });
    getGitHubPRStatus.mockResolvedValue({ number: 1 });
    await getTool("get_github_pr_status")!.handler({
      companyId: "c1",
      prNumber: 1,
      repo: "r",
      owner: "explicit-org",
    });
    expect(getGitHubPRStatus).toHaveBeenCalledWith(expect.anything(), "explicit-org", "r", 1);
  });

  it("fails when neither owner nor a default owner is available", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x" });
    const out = (await getTool("get_github_pr_status")!.handler({
      companyId: "c1",
      prNumber: 1,
      repo: "r",
    })) as any;
    expect(out.status).toBe("FAILED");
    expect(getGitHubPRStatus).not.toHaveBeenCalled();
  });

  it("returns FAILED (not throw) when the github call rejects", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "o" });
    getGitHubPRStatus.mockRejectedValue(new Error("GitHub get PR status failed: 404"));
    const out = (await getTool("get_github_pr_status")!.handler({
      companyId: "c1",
      prNumber: 999,
      repo: "r",
    })) as any;
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/404/);
  });
});

describe("get_github_branch_status — handler", () => {
  it("returns MISSING_INTEGRATION when the tenant has no GITHUB integration", async () => {
    getActiveIntegration.mockResolvedValue(null);
    const out = (await getTool("get_github_branch_status")!.handler({
      companyId: "c1",
      branch: "feat/x",
      repo: "r",
    })) as any;
    expect(out.status).toBe("MISSING_INTEGRATION");
    expect(getGitHubBranchStatus).not.toHaveBeenCalled();
  });

  it("calls getGitHubBranchStatus with base defaulting to main and returns COMPLETED", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "o" });
    getGitHubBranchStatus.mockResolvedValue({ name: "feat/x", aheadBy: 2, behindBy: 0, status: "ahead" });

    const out = (await getTool("get_github_branch_status")!.handler({
      companyId: "c1",
      branch: "feat/x",
      repo: "r",
    })) as any;

    expect(getGitHubBranchStatus).toHaveBeenCalledWith(
      { personalAccessToken: "ghp_x", defaultOwner: "o" },
      "o",
      "r",
      "feat/x",
      "main",
    );
    expect(out.status).toBe("COMPLETED");
    expect(out.branch.aheadBy).toBe(2);
  });

  it("threads an explicit base branch through", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "o" });
    getGitHubBranchStatus.mockResolvedValue({ name: "feat/x" });
    await getTool("get_github_branch_status")!.handler({
      companyId: "c1",
      branch: "feat/x",
      repo: "r",
      base: "develop",
    });
    expect(getGitHubBranchStatus).toHaveBeenCalledWith(expect.anything(), "o", "r", "feat/x", "develop");
  });

  it("returns FAILED (not throw) when the github call rejects", async () => {
    getActiveIntegration.mockResolvedValue({ personalAccessToken: "ghp_x", defaultOwner: "o" });
    getGitHubBranchStatus.mockRejectedValue(new Error("GitHub compare branch failed: 404"));
    const out = (await getTool("get_github_branch_status")!.handler({
      companyId: "c1",
      branch: "ghost",
      repo: "r",
    })) as any;
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/404/);
  });
});
