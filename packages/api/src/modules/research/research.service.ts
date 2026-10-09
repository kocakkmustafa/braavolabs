/**
 * Autonomous web research service.
 *
 * Loop:
 *   1. Search the web (Tavily preferred, Serper or Brave fallback).
 *   2. Fetch top-N candidate URLs in parallel.
 *   3. Distill each fetched page (readability extraction + LLM
 *      summary).
 *   4. Ask the LLM "are we done?" — given accumulated sources, can
 *      we answer the original query? If yes, synthesise findings.
 *      If no, generate up to 3 follow-up queries and loop back.
 *   5. Halt after `maxRounds` (default 3), `maxSources` (default 20),
 *      or `maxCostUsd` (default $1.00) — whichever hits first.
 *
 * SSRF guard wraps every outbound fetch — even though search results
 * are public URLs, an attacker who poisons the search index can
 * still feed us internal hostnames. Each fetch goes through
 * `safeExternalFetch`, which binds the validated destination to the socket.
 *
 * Robots.txt: respected via a per-host cache. Disallowed URLs are
 * skipped and recorded in the session's sources list with content="".
 *
 * Provider abstraction: SearchProvider interface lets the deployment
 * swap between Tavily (best quality), Serper (cheap), Brave (privacy-
 * preserving), or a "custom" HTTP endpoint. Config picks via env
 * `WEB_RESEARCH_PROVIDER`.
 */

import crypto from "node:crypto";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { safeExternalFetch, SsrfError } from "../../lib/ssrf";
import { runAgentLoop } from "../agent/claude";
import { compareAcrossModels, validateModelSelections, type ModelSelection } from "../../services/multi-model";

// ── Provider interface ──────────────────────────────────────

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}
export interface SearchProvider {
  search(query: string, opts?: { count?: number }): Promise<SearchHit[]>;
}

// ── Tavily (default) ────────────────────────────────────────

class TavilyProvider implements SearchProvider {
  constructor(private apiKey: string) {}
  async search(query: string, opts?: { count?: number }): Promise<SearchHit[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: "advanced",
        max_results: opts?.count ?? 8,
      }),
    });
    if (!res.ok) throw new AppError(502, `Tavily search failed: ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ url: string; title: string; content?: string }> };
    return (json.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content ?? "",
    }));
  }
}

class SerperProvider implements SearchProvider {
  constructor(private apiKey: string) {}
  async search(query: string, opts?: { count?: number }): Promise<SearchHit[]> {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: opts?.count ?? 10 }),
    });
    if (!res.ok) throw new AppError(502, `Serper search failed: ${res.status}`);
    const json = (await res.json()) as { organic?: Array<{ link: string; title: string; snippet?: string }> };
    return (json.organic ?? []).map((r) => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet ?? "",
    }));
  }
}

class BraveProvider implements SearchProvider {
  constructor(private apiKey: string) {}
  async search(query: string, opts?: { count?: number }): Promise<SearchHit[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(opts?.count ?? 10));
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": this.apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new AppError(502, `Brave search failed: ${res.status}`);
    const json = (await res.json()) as { web?: { results?: Array<{ url: string; title: string; description?: string }> } };
    return (json.web?.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.description ?? "",
    }));
  }
}

function getSearchProvider(): SearchProvider {
  const which = process.env.WEB_RESEARCH_PROVIDER ?? "tavily";
  if (which === "tavily" && process.env.TAVILY_API_KEY) return new TavilyProvider(process.env.TAVILY_API_KEY);
  if (which === "serper" && process.env.SERPER_API_KEY) return new SerperProvider(process.env.SERPER_API_KEY);
  if (which === "brave" && process.env.BRAVE_SEARCH_API_KEY) return new BraveProvider(process.env.BRAVE_SEARCH_API_KEY);
  throw new AppError(
    503,
    "No web-research search provider configured. Set WEB_RESEARCH_PROVIDER + the matching API key.",
  );
}

// ── Robots.txt cache ────────────────────────────────────────

const robotsCache = new Map<string, { fetchedAt: number; rules: string[] }>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const MAX_FETCH_BYTES = 1_500_000;
const RESEARCH_FETCH_POLICY = {
  requireHttps: true,
  redirectPolicy: "validated-public-https",
  maxResponseBytes: MAX_FETCH_BYTES,
  responseOverflow: "truncate",
} as const;

async function isUrlAllowed(targetUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  const host = parsed.host;
  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return !cached.rules.some((r) => parsed.pathname.startsWith(r));
  }
  let rules: string[] = [];
  try {
    const res = await safeExternalFetch(
      `${parsed.protocol}//${parsed.host}/robots.txt`,
      { signal: AbortSignal.timeout(5_000) },
      RESEARCH_FETCH_POLICY,
    );
    if (res.ok) {
      const body = await res.text();
      rules = parseRobots(body);
    }
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    // No robots.txt or fetch failed — assume allow (best-effort).
  }
  robotsCache.set(host, { fetchedAt: Date.now(), rules });
  return !rules.some((r) => parsed.pathname.startsWith(r));
}

function parseRobots(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const disallow: string[] = [];
  let weAreInScope = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") {
      weAreInScope = val === "*" || val.toLowerCase().includes("braavolabs");
    } else if (key === "disallow" && weAreInScope && val) {
      disallow.push(val);
    }
  }
  return disallow;
}

// ── Page fetch + readability ────────────────────────────────

const MAX_CONTENT_LENGTH = 50_000;

async function fetchPage(url: string): Promise<{ title: string | null; content: string } | null> {
  try {
    if (!(await isUrlAllowed(url))) {
      return { title: null, content: "" };
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      logger.debug("Skipping research URL — SSRF guard");
      return null;
    }
    throw err;
  }
  let res: Response;
  try {
    res = await safeExternalFetch(
      url,
      {
        headers: {
          "User-Agent":
            "Braavolabs-Research/1.0 (+https://braavolabs.com/bot; contact@braavolabs.com)",
          Accept: "text/html,application/xhtml+xml,text/plain",
          "Accept-Encoding": "identity",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: undefined,
      },
      RESEARCH_FETCH_POLICY,
    );
  } catch (err) {
    if (err instanceof SsrfError) {
      logger.debug("Skipping research URL — SSRF guard");
      return null;
    }
    return { title: null, content: "" };
  }
  if (!res.ok) return { title: null, content: "" };
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/")) return { title: null, content: "" };
  // Cap by bytes so a 50MB HTML page can't pin the worker.
  const buf = Buffer.alloc(MAX_FETCH_BYTES);
  let read = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return extractReadable(text);
  }
  while (read < MAX_FETCH_BYTES) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const slice = chunk.value.subarray(0, Math.min(chunk.value.length, MAX_FETCH_BYTES - read));
    buf.set(slice, read);
    read += slice.length;
  }
  await reader.cancel().catch(() => {});
  return extractReadable(buf.subarray(0, read).toString("utf8"));
}

function extractReadable(html: string): { title: string | null; content: string } {
  // Minimal HTML-to-text — strips <script>/<style>, drops tags,
  // collapses whitespace. Production-grade readability extraction
  // (Mozilla Readability) is a follow-up; this is good enough for
  // LLM consumption.
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1].trim() ?? null;
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title, content: stripped.slice(0, MAX_CONTENT_LENGTH) };
}

// ── Public run-research entry point ─────────────────────────

export interface RunResearchOptions {
  tenantId: string;
  companyId: string;
  query: string;
  maxRounds?: number;
  maxSources?: number;
  maxCostUsd?: number;
  initiatedByRunStepId?: string;
  /**
   * E2/T8 (plan §2.5): when true, the session's final synthesis is
   * augmented with a multi-model compare — the query (grounded on the
   * gathered sources) runs on ≤3 of the tenant's configured providers in
   * parallel and the per-model answers + consensus/disagreements are
   * embedded into the findings JSON under `multiModel`. A failed compare
   * never fails the research session (partial results rule).
   */
  multiModel?: boolean;
}

export async function startResearch(opts: RunResearchOptions): Promise<{ sessionId: string }> {
  const session = await prisma.webResearchSession.create({
    data: {
      tenantId: opts.tenantId,
      companyId: opts.companyId,
      query: opts.query,
      maxRounds: opts.maxRounds ?? 3,
      maxSources: opts.maxSources ?? 20,
      maxCostUsd: opts.maxCostUsd ?? 1.0,
      initiatedByRunStepId: opts.initiatedByRunStepId,
      status: "PENDING",
    },
  });
  // Fire-and-forget — the loop can take 30-120s; the caller doesn't
  // wait. UI polls /research/:id for status. Errors are persisted
  // onto the session row. The multiModel flag travels as a parameter
  // (not a session column — T6 is this epic's single migration).
  void runResearchLoop(session.id, opts.multiModel === true).catch((err) => {
    logger.error({ err, sessionId: session.id }, "Research loop crashed");
  });
  return { sessionId: session.id };
}

// ── Multi-model compare (E2/T8 — plan §2.5) ────────────────

export interface StartCompareOptions {
  selections?: ModelSelection[];
  tenantId: string;
  companyId: string;
  query: string;
  maxCandidates?: number;
  maxTokensPerCandidate?: number;
  maxCostUsd?: number;
  debateRounds?: number;
  initiatedByRunStepId?: string;
}

/**
 * Standalone compare-and-synthesize surface (POST /research/compare):
 * reuses the WebResearchSession lifecycle (PENDING → RUNNING →
 * COMPLETED/FAILED, findings JSON, costUsd) so the existing polling UI
 * works unchanged — but runs NO web search; the "sources" are the
 * tenant's own models answering in parallel.
 */
export async function startCompare(opts: StartCompareOptions): Promise<{ sessionId: string }> {
  if (opts.selections !== undefined) {
    try { await validateModelSelections(opts.tenantId, opts.selections, opts.maxCandidates); }
    catch (err) { throw new AppError(400, err instanceof Error ? err.message : "Invalid model selections"); }
  }
  const session = await prisma.webResearchSession.create({
    data: {
      tenantId: opts.tenantId,
      companyId: opts.companyId,
      query: opts.query,
      maxRounds: 1,
      maxSources: 0,
      maxCostUsd: opts.maxCostUsd ?? 1.0,
      initiatedByRunStepId: opts.initiatedByRunStepId,
      status: "PENDING",
    },
  });
  void runCompareSession(session.id, opts).catch((err) => {
    logger.error({ err, sessionId: session.id }, "Multi-model compare session crashed");
  });
  return { sessionId: session.id };
}

async function runCompareSession(sessionId: string, opts: StartCompareOptions): Promise<void> {
  await prisma.webResearchSession.update({
    where: { id: sessionId },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  try {
    const compare = await compareAcrossModels(opts.tenantId, opts.query, {
      selections: opts.selections,
      maxCandidates: opts.maxCandidates,
      maxTokensPerCandidate: opts.maxTokensPerCandidate,
      maxCostUsd: opts.maxCostUsd,
      debateRounds: opts.debateRounds,
    });
    await prisma.webResearchSession.update({
      where: { id: sessionId },
      data: {
        // Invalid structured output must be visibly failed. Paid candidate
        // answers and full metered cost remain available as partial findings.
        status: compare.synthesisStatus === "invalid_structured" ? "FAILED" : "COMPLETED",
        ...(compare.synthesisStatus === "invalid_structured"
          ? { error: compare.synthesizerError ?? "Invalid structured synthesis" }
          : {}),
        // Same findings envelope as research (summary + claims) so every
        // existing consumer renders it; the full compare payload —
        // perModel answers, consensus, disagreements, synthesizer — is
        // embedded under `multiModel` (plan §2.5: "research findings
        // JSON'ına gömülür").
        findings: { summary: compare.finalAnswer, claims: [], multiModel: compare } as any,
        costUsd: compare.totalCostUsd,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webResearchSession.update({
      where: { id: sessionId },
      data: {
        status: "FAILED",
        error: message,
        completedAt: new Date(),
      },
    });
  }
}

/**
 * multiModel:true leg of a research session: re-run the query — grounded
 * on a digest of the gathered sources — across the tenant's providers and
 * attach the compare block to the findings. Additive and non-fatal: any
 * error leaves the original findings untouched.
 */
async function augmentFindingsWithMultiModel(
  session: { id: string; tenantId: string; query: string; maxCostUsd: unknown },
  allSources: Array<{ url: string; title: string | null; content: string }>,
  findings: unknown,
  costSoFar: number,
): Promise<{ findings: unknown; addedCostUsd: number }> {
  try {
    const digest = allSources
      .slice(0, 5)
      .map((s, i) => `[${i}] ${s.title ?? "(untitled)"} — ${s.url}\n${s.content.slice(0, 800)}`)
      .join("\n\n");
    const task = digest
      ? `${session.query}\n\nBase your answer on these sources where possible:\n${digest}`
      : session.query;
    const remainingBudget = Math.max(0.1, Number(session.maxCostUsd) - costSoFar);
    const compare = await compareAcrossModels(session.tenantId, task, {
      maxCostUsd: remainingBudget,
    });
    const base =
      findings && typeof findings === "object" && !Array.isArray(findings)
        ? (findings as Record<string, unknown>)
        : { summary: String(findings ?? ""), claims: [] };
    return { findings: { ...base, multiModel: compare }, addedCostUsd: compare.totalCostUsd };
  } catch (err) {
    logger.warn(
      { sessionId: session.id, err: (err as Error).message },
      "multiModel augment failed (non-fatal) — research findings stand without it",
    );
    return { findings, addedCostUsd: 0 };
  }
}

async function runResearchLoop(sessionId: string, multiModel = false): Promise<void> {
  const session = await prisma.webResearchSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  const tenantId =
    typeof session.tenantId === "string" && session.tenantId.trim().length > 0
      ? session.tenantId
      : null;
  if (!tenantId) {
    await prisma.webResearchSession.update({
      where: { id: sessionId },
      data: {
        status: "FAILED",
        error: "Research session has no valid tenant binding; provider execution was refused.",
        completedAt: new Date(),
      },
    });
    return;
  }
  await prisma.webResearchSession.update({
    where: { id: sessionId },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  const provider = getSearchProvider();
  let cost = 0;
  let totalSources = 0;
  let unsafeRejectedSources = 0;
  let currentQueries = [session.query];
  let allSources: Array<{ id: string; url: string; title: string | null; content: string; relevance: number }> = [];

  try {
    for (let round = 0; round < session.maxRounds; round++) {
      if (totalSources >= session.maxSources) break;
      if (cost >= Number(session.maxCostUsd)) break;

      // Search every active query in parallel.
      const allHits = (
        await Promise.all(currentQueries.map((q) => provider.search(q, { count: 6 }).catch(() => [])))
      ).flat();

      // De-dup by URL and limit to remaining source budget.
      const remaining = session.maxSources - totalSources;
      const seenUrls = new Set(allSources.map((s) => s.url));
      const fresh = allHits.filter((h) => !seenUrls.has(h.url)).slice(0, remaining);

      // Fetch in parallel with a concurrency cap of 5 — the same
      // ratio we use for parallel tool calls so we don't melt the
      // event loop.
      const fetched: Array<{ url: string; title: string | null; content: string; snippet: string }> = [];
      const queue = [...fresh];
      const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length > 0) {
          const hit = queue.shift()!;
          const page = await fetchPage(hit.url);
          if (!page) {
            unsafeRejectedSources++;
            continue;
          }
          fetched.push({ url: hit.url, title: page.title ?? hit.title, content: page.content, snippet: hit.snippet });
        }
      });
      await Promise.all(workers);

      // Persist sources with SHA-256 content hash dedup.
      for (const f of fetched) {
        const contentHash = crypto.createHash("sha256").update(f.content).digest("hex");
        try {
          const row = await prisma.webResearchSource.create({
            data: {
              sessionId,
              url: f.url,
              title: f.title,
              content: f.content,
              contentHash,
              relevance: 0,
            },
          });
          allSources.push({ id: row.id, url: row.url, title: row.title, content: row.content, relevance: 0 });
          totalSources++;
        } catch {
          // Unique violation on contentHash — duplicate page across
          // queries. Ignore.
        }
      }

      // Unsafe search results must never become stored source records or an
      // ungrounded LLM prompt after the socket-bound guard rejects them.
      if (allSources.length === 0 && unsafeRejectedSources > 0) continue;

      // Ask Claude: have we got enough to answer, or do we need
      // more queries? The reply schema is strict JSON so we can
      // parse it deterministically.
      const distill = await runAgentLoop({
        systemPrompt:
          `You are a research analyst. The user asked: "${session.query}". ` +
          `Below are the sources you've gathered so far. ` +
          `Decide whether you can answer confidently. ` +
          `Respond with STRICT JSON: ` +
          `{"done": true, "findings": {"summary": string, "claims": [{"claim": string, "citations": [sourceIdx, ...]}]}} ` +
          `OR ` +
          `{"done": false, "followUps": [string, string, ...]} ` +
          `Source indices are 0-based into the supplied list. Maximum 3 follow-up queries.`,
        userMessage:
          `Sources (${allSources.length} total):\n` +
          allSources
            .map((s, i) => `[${i}] ${s.title ?? "(untitled)"} — ${s.url}\n${s.content.slice(0, 1200)}`)
            .join("\n\n---\n\n"),
        toolNames: [],
        tenantId,
      });
      cost += distill.totalCostUsd ?? 0;

      let parsed: { done: true; findings: unknown } | { done: false; followUps: string[] } | null = null;
      try {
        parsed = JSON.parse(distill.finalContent.trim());
      } catch {
        // Try to find a JSON block inside the response.
        const match = distill.finalContent.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            /* ignore */
          }
        }
      }

      if (parsed && parsed.done) {
        let findings: unknown = parsed.findings;
        if (multiModel) {
          const augmented = await augmentFindingsWithMultiModel(session, allSources, findings, cost);
          findings = augmented.findings;
          cost += augmented.addedCostUsd;
        }
        await prisma.webResearchSession.update({
          where: { id: sessionId },
          data: {
            status: "COMPLETED",
            findings: findings as any,
            costUsd: cost,
            completedAt: new Date(),
          },
        });
        return;
      }
      if (parsed && !parsed.done && Array.isArray(parsed.followUps) && parsed.followUps.length > 0) {
        currentQueries = parsed.followUps.slice(0, 3);
      } else {
        // Manager LLM returned an unparseable response — treat as
        // "done" with whatever we have rather than spinning.
        break;
      }
    }

    if (allSources.length === 0 && unsafeRejectedSources > 0) {
      await prisma.webResearchSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          findings: { summary: "No safe research sources were available.", claims: [] },
          costUsd: cost,
          completedAt: new Date(),
        },
      });
      return;
    }

    // Ran out of rounds / sources / budget. Synthesise from what we
    // have so the caller still gets something usable.
    const final = await runAgentLoop({
      systemPrompt:
        `Summarise the gathered sources as a concise answer to: "${session.query}". ` +
        `Return JSON: {"summary": string, "claims": [{"claim": string, "citations": [sourceIdx]}]}.`,
      userMessage: allSources
        .map((s, i) => `[${i}] ${s.title ?? "(untitled)"} — ${s.url}\n${s.content.slice(0, 1500)}`)
        .join("\n\n---\n\n"),
      toolNames: [],
      tenantId,
    });
    cost += final.totalCostUsd ?? 0;
    let findings: unknown = { summary: final.finalContent.slice(0, 4000), claims: [] };
    try {
      findings = JSON.parse(final.finalContent.trim());
    } catch {
      /* leave the fallback */
    }
    if (multiModel) {
      const augmented = await augmentFindingsWithMultiModel(session, allSources, findings, cost);
      findings = augmented.findings;
      cost += augmented.addedCostUsd;
    }
    await prisma.webResearchSession.update({
      where: { id: sessionId },
      data: {
        status: "COMPLETED",
        findings: findings as any,
        costUsd: cost,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webResearchSession.update({
      where: { id: sessionId },
      data: {
        status: "FAILED",
        error: message,
        costUsd: cost,
        completedAt: new Date(),
      },
    });
  }
}
