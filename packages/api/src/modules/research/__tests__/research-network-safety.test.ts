import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));
const sourceCreateMock = vi.hoisted(() => vi.fn());
const runAgentLoopMock = vi.hoisted(() => vi.fn());
const safeExternalFetchMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const ssrfMock = vi.hoisted(() => {
  class SsrfError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfError";
    }
  }
  return { SsrfError };
});

vi.mock("../../../lib/db", () => ({
  prisma: {
    webResearchSession: sessionMock,
    webResearchSource: { create: sourceCreateMock },
  },
}));

vi.mock("../../../lib/logger", () => ({ logger: loggerMock }));

vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
}));

vi.mock("../../../services/multi-model", () => ({
  compareAcrossModels: vi.fn(),
}));

vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: vi.fn().mockResolvedValue(undefined),
  safeExternalFetch: (...args: unknown[]) => safeExternalFetchMock(...args),
  SsrfError: ssrfMock.SsrfError,
}));

import { startResearch } from "../research.service";

const originalResearchProvider = process.env.WEB_RESEARCH_PROVIDER;
const originalTavilyKey = process.env.TAVILY_API_KEY;

function persistedSession() {
  return {
    id: "research-network-session",
    tenantId: "tenant-1",
    companyId: "company-1",
    query: "Investigate a network-safe source",
    maxRounds: 1,
    maxSources: 5,
    maxCostUsd: 1,
    status: "PENDING",
  };
}

function searchResponse(url: string): Response {
  return new Response(JSON.stringify({
    results: [{ url, title: "Search result", content: "Search snippet" }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function searchResponses(urls: string[]): Response {
  return new Response(JSON.stringify({
    results: urls.map((url, index) => ({
      url,
      title: `Search result ${index}`,
      content: `Search snippet ${index}`,
    })),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function robotsResponse(body = "User-agent: *\nDisallow:"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function pageResponse(body = "<html><title>Safe page</title><body>verified content</body></html>"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function runWithHit(url: string): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const href = String(input);
    if (href === "https://api.tavily.com/search") return searchResponse(url);
    throw new Error(`native research fetch forbidden: ${href}`);
  }));

  await startResearch({
    tenantId: "tenant-1",
    companyId: "company-1",
    query: "Investigate a network-safe source",
    maxRounds: 1,
  });
}

async function waitForTerminalSession(): Promise<void> {
  await vi.waitFor(() => {
    expect(sessionMock.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: expect.stringMatching(/COMPLETED|FAILED/) }),
    }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_RESEARCH_PROVIDER = "tavily";
  process.env.TAVILY_API_KEY = "hermetic-search-key";
  sessionMock.create.mockResolvedValue({ id: "research-network-session" });
  sessionMock.findUnique.mockResolvedValue(persistedSession());
  sessionMock.update.mockImplementation(async ({ data }: { data: unknown }) => data);
  sourceCreateMock.mockResolvedValue({
    id: "source-1",
    url: "https://public.example/article",
    title: "Safe page",
    content: "verified content",
  });
  runAgentLoopMock.mockResolvedValue({
    finalContent: '{"done":true,"findings":{"summary":"grounded","claims":[]}}',
    totalCostUsd: 0,
    turns: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalResearchProvider === undefined) delete process.env.WEB_RESEARCH_PROVIDER;
  else process.env.WEB_RESEARCH_PROVIDER = originalResearchProvider;
  if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyKey;
});

describe("research network safety — socket-bound robots and page retrieval", () => {
  it("routes both requests through strict safeExternalFetch and preserves page behavior", async () => {
    safeExternalFetchMock
      .mockResolvedValueOnce(robotsResponse())
      .mockResolvedValueOnce(pageResponse());

    await runWithHit("https://public.example/article");
    await waitForTerminalSession();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.tavily.com/search", expect.any(Object));
    expect(safeExternalFetchMock).toHaveBeenNthCalledWith(
      1,
      "https://public.example/robots.txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({
        requireHttps: true,
        redirectPolicy: "validated-public-https",
        maxResponseBytes: 1_500_000,
        responseOverflow: "truncate",
      }),
    );
    expect(safeExternalFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://public.example/article",
      expect.objectContaining({
        redirect: undefined,
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Braavolabs-Research/1.0"),
          Accept: "text/html,application/xhtml+xml,text/plain",
        }),
      }),
      expect.objectContaining({
        requireHttps: true,
        redirectPolicy: "validated-public-https",
        maxResponseBytes: 1_500_000,
        responseOverflow: "truncate",
      }),
    );
    expect(sourceCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        url: "https://public.example/article",
        content: "Safe page verified content",
      }),
    }));
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://8.8.8.8/article",
    "https://10.0.0.7/article",
    "https://127.9.8.7/article",
    "https://169.254.169.254/latest/meta-data/",
    "https://169.254.0.23/latest/meta-data/",
    "https://[::ffff:a9fe:17]/latest/meta-data/",
    "https://mixed-dns.example/article",
    "https://rebind.example/article",
  ])("drops unsafe robots target %s before body, source persistence, or LLM", async (url) => {
    safeExternalFetchMock.mockRejectedValueOnce(
      new ssrfMock.SsrfError("unsafe destination rejected without raw target disclosure"),
    );

    await runWithHit(url);
    await waitForTerminalSession();

    expect(safeExternalFetchMock).toHaveBeenCalledTimes(1);
    expect(sourceCreateMock).not.toHaveBeenCalled();
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerMock.debug.mock.calls)).not.toContain(url);
    expect(JSON.stringify(loggerMock.warn.mock.calls)).not.toContain(url);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(url);
  });

  it("drops a public-to-private page redirect rejection before persistence or LLM", async () => {
    safeExternalFetchMock
      .mockResolvedValueOnce(robotsResponse())
      .mockRejectedValueOnce(new ssrfMock.SsrfError("unsafe redirect target rejected"));

    await runWithHit("https://redirect-source.example/redirecting-article");
    await waitForTerminalSession();

    expect(safeExternalFetchMock).toHaveBeenCalledTimes(2);
    expect(sourceCreateMock).not.toHaveBeenCalled();
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("preserves robots disallow as a recorded empty source without fetching the page", async () => {
    safeExternalFetchMock.mockResolvedValueOnce(
      robotsResponse("User-agent: Braavolabs-Research\nDisallow: /private"),
    );

    await runWithHit("https://robots-disallow.example/private/report");
    await waitForTerminalSession();

    expect(safeExternalFetchMock).toHaveBeenCalledTimes(1);
    expect(sourceCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: "" }),
    }));
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the 1.5 MiB processing and 50,000-character extraction caps", async () => {
    safeExternalFetchMock
      .mockResolvedValueOnce(robotsResponse())
      .mockResolvedValueOnce(pageResponse(`<html><body>${"a".repeat(1_600_000)}</body></html>`));

    await runWithHit("https://large-page.example/large-article");
    await waitForTerminalSession();

    const persistedContent = sourceCreateMock.mock.calls[0]?.[0]?.data?.content as string;
    expect(persistedContent.length).toBe(50_000);
  });

  it("preserves the five-page concurrency cap", async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://parallel-${index}.example/article`);
    sessionMock.findUnique.mockResolvedValue({ ...persistedSession(), maxSources: 6 });
    let activePages = 0;
    let maximumActivePages = 0;
    safeExternalFetchMock.mockImplementation(async (input: string | URL) => {
      if (String(input).endsWith("/robots.txt")) return robotsResponse();
      activePages += 1;
      maximumActivePages = Math.max(maximumActivePages, activePages);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activePages -= 1;
      return pageResponse();
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://api.tavily.com/search") return searchResponses(urls);
      throw new Error(`native research fetch forbidden: ${String(input)}`);
    }));

    await startResearch({
      tenantId: "tenant-1",
      companyId: "company-1",
      query: "Parallel source safety",
      maxRounds: 1,
      maxSources: 6,
    });
    await waitForTerminalSession();

    expect(maximumActivePages).toBe(5);
    expect(sourceCreateMock).toHaveBeenCalledTimes(6);
  });
});
