import crypto from "crypto";
import { spawn } from "node:child_process";
import { env } from "../../config/env";
import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { slugify } from "@ai-company-os/core";
import { PRIMITIVES, PLAN_LIMITS } from "@ai-company-os/core";
import { assertCompanyCapacity } from "./company-capacity";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";
import { chatCompletion, type ChatMessage } from "../../services/ai-client";
// D-013: resolveTenantCompletionLink (not the raw getTenantAIConfig) — this
// is a single-completion call site, so it must honor the SAME D-009 policy
// the run loop does (BYOK → counted trial → opt-in/PAID system → honest
// error) instead of silently spending the shared system Anthropic key for a
// keyless tenant. commitTrialCompletion counts the trial slot on success.
import { resolveTenantCompletionLink, commitTrialCompletion, refundTrialCompletion } from "../../services/provider-chain";

const isLocalMode = env.LLM_PROVIDER === "local";

/**
 * Call AI via CLI (local mode) or unified AI client (API mode).
 * Supports all configured providers: Anthropic, OpenAI, Google, Mistral, Groq, OpenRouter.
 */
async function callAI(
  systemPrompt: string,
  messages: ChatMessage[],
  tenantId: string,
): Promise<string> {
  if (isLocalMode) {
    // Build conversation as text for CLI (Claude Code local mode)
    const prompt = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\n${prompt}`;
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", ["-p", "-", "--output-format", "json"], {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude CLI timed out after 300 seconds"));
      }, 300_000);
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Claude CLI error (exit ${code}): ${(stderr || "").slice(0, 500)}`));
          return;
        }
        try {
          const response = JSON.parse(stdout);
          resolve(response.result ?? "");
        } catch {
          reject(new Error(`Claude CLI JSON parse error: ${stdout.slice(0, 500)}`));
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Claude CLI spawn error: ${err.message}`));
      });
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });
    return result;
  }

  // API mode — resolve the tenant's D-009 chain head (BYOK → counted trial →
  // opt-in/PAID system → honest error), never a silent system-key fallthrough.
  const link = await resolveTenantCompletionLink(tenantId);
  let result;
  try {
    result = await chatCompletion(link.config, systemPrompt, messages, 4096);
  } catch (err) {
    // Refund an unused hosted-trial cost reservation before rethrowing —
    // symmetric with the commit below (exactly one of the two must fire).
    await refundTrialCompletion(tenantId, link.source);
    throw err;
  }
  // Count the trial slot only after a successful serve (D-009/D-013 parity).
  await commitTrialCompletion(tenantId, link.source, result);
  return result.content;
}

const MAX_CLARIFICATION_TURNS = 3;

export interface BuilderSession {
  sessionId: string;
  tenantId: string;
  status: "clarifying" | "ready" | "created" | "error";
  turn: number;
  messages: ChatMessage[];
  companySpec?: CompanySpec;
  companyId?: string;
}

export interface CompanySpec {
  name: string;
  slug: string;
  description: string;
  primitives: string[];
  agents: Array<{
    name: string;
    role: string;
    systemPrompt: string;
    tools: string[];
  }>;
  pipelines: Array<{
    name: string;
    trigger: string;
    schedule?: string;
    steps: Array<{
      name: string;
      agentRole: string;
      order: number;
    }>;
  }>;
  config: Record<string, unknown>;
  requiredIntegrations?: Array<{
    provider: string;
    reason: string;
  }>;
}

const SYSTEM_PROMPT = `You are the AI Company Builder for Braavolabs.

Your job is to help users create AI-powered companies from freeform text descriptions.

## Available Primitives
${PRIMITIVES.map((p) => `- **${p.id}**: ${p.description}`).join("\n")}

## Your Task
1. Analyze the user's company description
2. If critical information is missing, ask clarifying questions (max ${MAX_CLARIFICATION_TURNS} rounds)
3. When you have enough info, output a COMPLETE company specification

## What You MUST Determine
- Company name and purpose
- Which primitives are needed
- What agents to create (name, role, tools)
- What pipelines to set up (name, trigger, steps)
- Target channels/platforms if applicable

## Pipeline Step Rule (STRICT)
Every step's "agentRole" MUST exactly match the "role" of one of the agents
you create. NEVER invent human roles ("Founder", "Owner", "Human", "Manager")
as agentRole — human approval is automatic: spend and outbound steps pause
for the operator via the approval system, so do not model review/approval
as separate steps.

## Naming Rule (STRICT)
The company "name" field MUST be 2–4 words. Never echo the description verbatim.
Pick a punchy noun phrase that captures the topic.
- BAD:  "A simple TikTok content factory for indie game devs"
- GOOD: "Indie Game TikTok Studio"
- BAD:  "Build me a B2B SaaS sales agent that books demos"
- GOOD: "B2B Demo Booker"
If the user provided an explicit name (e.g. "called X" or "named X"), use that as-is.
Title-case the result. No trailing period.

## Clarification Rules
- Ask AT MOST ${MAX_CLARIFICATION_TURNS} rounds of questions
- Group related questions together
- Don't ask about things you can reasonably infer
- If the description is detailed enough, skip clarification entirely

## Output Format
When ready, output the company spec as a JSON block:

\`\`\`json
{
  "ready": true,
  "company": {
    "name": "...",
    "description": "...",
    "primitives": ["CONTENT", "ANALYTICS", ...],
    "agents": [
      {
        "name": "...",
        "role": "...",
        "systemPrompt": "...",
        "tools": ["generate_post", "create_draft", ...]
      }
    ],
    "pipelines": [
      {
        "name": "...",
        "trigger": "SCHEDULED",
        "schedule": "0 9 * * *",
        "steps": [
          { "name": "...", "agentRole": "...", "order": 1 }
        ]
      }
    ],
    "config": {}
  }
}
\`\`\`

If you need more information, output:
\`\`\`json
{
  "ready": false,
  "questions": ["Question 1?", "Question 2?"]
}
\`\`\``;

// In-memory session store with TTL cleanup (1 hour expiry)
const sessions = new Map<string, BuilderSession & { expiresAt: number }>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS_PER_TENANT = 5;

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}, 5 * 60 * 1000);

/**
 * Pull a usable 2-4 word company name out of a freeform description without
 * calling the LLM. Used only when the LLM call fails — the LLM does a much
 * better job when it succeeds. Tested cases:
 *   "A TikTok content factory for indie game devs"
 *     → "TikTok Content Factory"     (topic-noun + descriptor)
 *   "Build me a B2B SaaS sales agent called CloseBot"
 *     → "CloseBot"                   (named regex)
 *   "social media management for skincare brands"
 *     → "Social Media Management"    (title-case first 3 words)
 *   "agency"
 *     → "Agency"                     (single word fallback)
 */
export function extractFallbackCompanyName(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "My AI Company";

  // 1) "called X" / "named X" / "company: X" — capture up to 4 words.
  const namedRe = /(?:\b(?:called|named|company[:\s]+)\b)\s*["']?([A-Za-z0-9][A-Za-z0-9 .&-]{1,40}?)["']?(?:\s|[,.!?]|$)/i;
  const namedMatch = trimmed.match(namedRe);
  if (namedMatch?.[1]) {
    const cand = namedMatch[1].trim().replace(/\s+/g, " ");
    if (cand.split(" ").length <= 4) return titleCase(cand);
  }

  // 2) Topic-noun extraction. Drop stop-words and articles, keep the first
  // 2-3 substantive tokens (length ≥ 3 chars, alphanumeric).
  const STOP = new Set([
    "a", "an", "the", "and", "or", "but", "for", "to", "of", "in", "on",
    "with", "without", "is", "are", "be", "build", "create", "make", "set",
    "up", "get", "let", "run", "want", "need", "would", "should", "i", "we",
    "my", "our", "your", "you", "me", "us", "this", "that", "these", "those",
    "simple", "small", "quick", "easy", "good", "great", "nice", "best",
    "kind", "sort", "type", "thing", "stuff", "company",
  ]);
  const tokens = trimmed
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 4);

  if (tokens.length >= 2) {
    // Prefer 3 tokens when they fit comfortably, else 2.
    const pick = tokens.slice(0, tokens.length >= 3 ? 3 : 2);
    return titleCase(pick.join(" "));
  }

  if (tokens.length === 1) return titleCase(tokens[0]);

  // 3) Last resort — first up-to-3 raw words, title-cased.
  const raw = trimmed.split(/\s+/).slice(0, 3).join(" ");
  return raw ? titleCase(raw) : "My AI Company";
}

function titleCase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((part) =>
      /^\s+$/.test(part)
        ? part
        : part.length <= 2 && part.toUpperCase() === part
          ? part // keep ALLCAPS short tokens (TR, AI, B2B)
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Recheck capacity before spending a completion, including open sessions. */
async function hasBuilderCapacity(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { companies: { select: { id: true } } },
  });
  if (!tenant) throw new AppError(401, "Tenant not found");
  const plan = await getEffectivePlan(tenantId, tenant.plan);
  const limit = PLAN_LIMITS[plan].maxCompanies;
  return limit === -1 || tenant.companies.length < limit;
}

/**
 * Start a new company building session from freeform text.
 */
export async function startBuildSession(
  tenantId: string,
  description: string,
): Promise<BuilderSession> {
  const sessionId = `build_${crypto.randomUUID()}`;

  if (!await hasBuilderCapacity(tenantId)) {
    return {
      sessionId,
      tenantId,
      status: "error",
      turn: 0,
      messages: [],
      companySpec: undefined,
      companyId: undefined,
    };
  }

  const messages: ChatMessage[] = [
    { role: "user", content: description },
  ];

  let assistantText: string;
  let parsed: BuilderOutput;

  try {
    assistantText = await callAI(SYSTEM_PROMPT, messages, tenantId);
    messages.push({ role: "assistant", content: assistantText });
    parsed = parseBuilderResponse(assistantText);
  } catch (err) {
    // No more "fallback dummy spec" — building a company without an LLM
    // produced generic placeholder agents that confused users (3 lookalike
    // companies named "For", "My AI Company" populated production DB during
    // testing). Better to fail loudly and tell the user what to fix.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, tenantId }, "Builder LLM call failed — surfacing actionable error");
    if (/no ai provider|api key|not initialized|configure|please add an api key/i.test(msg)) {
      throw new AppError(
        400,
        "AI provider key required to build a company. Configure one in Settings → AI Provider — Anthropic, OpenAI, Gemini, Groq, Mistral, OpenRouter, or self-hosted Ollama / LM Studio all work.",
      );
    }
    if (/timeout|unreachable|fetch/i.test(msg)) {
      throw new AppError(
        503,
        `AI provider unreachable: ${msg}. If you're using a self-hosted endpoint (Ollama / LM Studio) verify it's running. For cloud providers, retry in a moment.`,
      );
    }
    throw new AppError(502, `Builder LLM call failed: ${msg}`);
  }

  // Enforce per-tenant session limit
  let tenantSessionCount = 0;
  for (const s of sessions.values()) {
    if (s.tenantId === tenantId) tenantSessionCount++;
  }
  if (tenantSessionCount >= MAX_SESSIONS_PER_TENANT) {
    throw new AppError(429, "Too many active build sessions. Please wait for existing sessions to expire.");
  }

  const session: BuilderSession & { expiresAt: number } = {
    sessionId,
    tenantId,
    status: parsed.ready ? "ready" : "clarifying",
    turn: 1,
    messages,
    companySpec: parsed.ready ? buildSpec(parsed.company) : undefined,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  sessions.set(sessionId, session);

  logger.info(
    { sessionId, status: session.status, turn: session.turn },
    "Build session started",
  );

  return session;
}

/**
 * Continue a build session with user's answer to clarification questions.
 */
export async function continueBuildSession(
  sessionId: string,
  tenantId: string,
  userResponse: string,
): Promise<BuilderSession> {
  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    if (session) sessions.delete(sessionId);
    throw new AppError(404, "Session not found or expired");
  }
  if (session.tenantId !== tenantId) throw new AppError(403, "Not authorized to access this session");
  if (session.status !== "clarifying") throw new AppError(400, "Session is not in clarification state");
  if (!await hasBuilderCapacity(tenantId)) {
    throw new AppError(402, "Company limit reached for your current plan. Upgrade to build more.");
  }

  session.messages.push({ role: "user", content: userResponse });
  session.turn++;

  const assistantText = await callAI(SYSTEM_PROMPT, session.messages, session.tenantId);

  session.messages.push({ role: "assistant", content: assistantText });

  const parsed = parseBuilderResponse(assistantText);

  if (parsed.ready) {
    session.status = "ready";
    session.companySpec = buildSpec(parsed.company);
  } else if (session.turn >= MAX_CLARIFICATION_TURNS) {
    // Force ready after max turns — Claude should make best guesses
    session.messages.push({
      role: "user",
      content:
        "No more questions. Please create the company with your best judgment based on the information provided so far. Output the JSON spec now.",
    });

    const finalText = await callAI(SYSTEM_PROMPT, session.messages, session.tenantId);

    session.messages.push({ role: "assistant", content: finalText });
    session.turn++;

    const finalParsed = parseBuilderResponse(finalText);
    session.status = "ready";
    session.companySpec = buildSpec(finalParsed.company ?? {});
  }

  sessions.set(sessionId, session);
  return session;
}

/**
 * Confirm and create the company from a ready session.
 */
export async function confirmBuild(sessionId: string, tenantId: string): Promise<BuilderSession> {
  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    if (session) sessions.delete(sessionId);
    throw new AppError(404, "Session not found or expired");
  }
  if (session.tenantId !== tenantId) throw new AppError(403, "Not authorized to access this session");
  if (session.status !== "ready" || !session.companySpec) {
    throw new AppError(400, "Session is not ready for confirmation");
  }

  const spec = session.companySpec;

  const company = await tenantTx(async (tx) => {
    await assertCompanyCapacity(tx, session.tenantId);
    const created = await tx.company.create({
      data: {
        tenantId: session.tenantId,
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        primitives: spec.primitives as any,
        status: "ACTIVE",
        config: spec.config as any,
      },
    });

    for (const agentDef of spec.agents) {
      await tx.agent.create({
        data: {
          companyId: created.id,
          name: agentDef.name,
          role: agentDef.role,
          systemPrompt: agentDef.systemPrompt,
          tools: agentDef.tools,
        },
      });
    }

    for (const pipelineDef of spec.pipelines) {
      await tx.pipeline.create({
        data: {
          companyId: created.id,
          name: pipelineDef.name,
          trigger: pipelineDef.trigger as any,
          schedule: pipelineDef.schedule,
          steps: pipelineDef.steps as any,
        },
      });
    }

    await tx.activityLog.create({
      data: {
        tenantId: session.tenantId,
        actor: "company_builder",
        action: "company.build",
        resource: "company",
        resourceId: created.id,
        details: {
          sessionId,
          turns: session.turn,
          primitives: spec.primitives,
          agentCount: spec.agents.length,
          pipelineCount: spec.pipelines.length,
        },
      },
    });
    return created;
  });

  // Check for missing integrations
  let missingIntegrations: Array<{ provider: string; reason: string; setupGuide: string }> = [];
  if (spec.requiredIntegrations && spec.requiredIntegrations.length > 0) {
    const { getMissingIntegrations } = require("../integration/checker");
    const requiredProviders = spec.requiredIntegrations.map((r: any) => r.provider);
    const missing = await getMissingIntegrations(company.id, requiredProviders);
    missingIntegrations = missing.map((m: any) => ({
      provider: m.provider,
      reason: spec.requiredIntegrations!.find((r: any) => r.provider === m.provider)?.reason ?? "",
      setupGuide: m.info?.setupGuide ?? "",
    }));
  }

  session.status = "created";
  session.companyId = company.id;
  (session as any).missingIntegrations = missingIntegrations;
  sessions.set(sessionId, session);

  logger.info(
    { sessionId, companyId: company.id, name: spec.name, missingIntegrations: missingIntegrations.length },
    "Company built successfully",
  );

  return session;
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string, tenantId: string): BuilderSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    if (session) sessions.delete(sessionId);
    return undefined;
  }
  if (session.tenantId !== tenantId) return undefined;
  return session;
}

// ─── Helpers ────────────────────────────────────────────

interface BuilderOutput {
  ready: boolean;
  company?: any;
  questions?: string[];
}

function parseBuilderResponse(text: string): BuilderOutput {
  // Extract JSON block from response
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    // Try to find raw JSON object
    const rawMatch = text.match(/\{[\s\S]*"ready"\s*:\s*(true|false)[\s\S]*\}/);
    if (rawMatch) {
      try {
        return JSON.parse(rawMatch[0]);
      } catch {
        // Fall through
      }
    }
    return { ready: false, questions: ["Could you describe your company idea in more detail?"] };
  }

  try {
    return JSON.parse(jsonMatch[1]);
  } catch {
    return { ready: false, questions: ["Could you provide more details about your company?"] };
  }
}

function buildSpec(raw: any): CompanySpec {
  const name = raw?.name ?? "My AI Company";
  const agents = (raw?.agents ?? []).map((a: any) => ({
    name: a.name ?? "Agent",
    role: a.role ?? slugify(a.name ?? "agent"),
    systemPrompt:
      a.systemPrompt ??
      `You are the ${a.name ?? "Agent"} for ${name}. ${a.role ? `Your role is ${a.role}.` : ""}`,
    tools: a.tools ?? [],
  }));

  // Detect required integrations from agent tools
  const { TOOL_PROVIDER_MAP, PROVIDER_INFO } = require("../integration/checker");
  const allTools = agents.flatMap((a: any) => a.tools);
  const providerSet = new Map<string, string>();
  for (const tool of allTools) {
    const provider = TOOL_PROVIDER_MAP[tool];
    if (provider && !providerSet.has(provider)) {
      const info = PROVIDER_INFO[provider];
      providerSet.set(provider, `Required for ${tool} — ${info?.description ?? provider}`);
    }
  }

  const requiredIntegrations = Array.from(providerSet.entries()).map(([provider, reason]) => ({
    provider,
    reason,
  }));

  return {
    name,
    slug: slugify(name),
    description: raw?.description ?? "",
    primitives: raw?.primitives ?? ["CONTENT", "ANALYTICS"],
    agents,
    pipelines: (raw?.pipelines ?? []).map((p: any) => {
      // The model sometimes invents trigger names ("NEW_LEAD", "ON_SIGNUP")
      // that aren't in the PipelineTrigger enum — Prisma then 500s the
      // whole confirm. Clamp to the enum: schedule-bearing pipelines stay
      // SCHEDULED, everything unrecognized becomes MANUAL.
      const VALID_TRIGGERS = ["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"];
      let trigger = String(p.trigger ?? "MANUAL").toUpperCase().trim();
      if (!VALID_TRIGGERS.includes(trigger)) {
        trigger = p.schedule ? "SCHEDULED" : "MANUAL";
      }
      if (trigger === "SCHEDULED" && !p.schedule) trigger = "MANUAL";
      return {
        name: p.name ?? "Default Pipeline",
        trigger,
        schedule: p.schedule,
        steps: (p.steps ?? []).map((s: any, i: number) => {
          // The model occasionally assigns steps to humans ("Founder",
          // "Owner") or roles it never created — those can never resolve
          // at execution time. Clamp to a real agent: exact/loose role or
          // name match first (mirrors the executor's matcher), else the
          // first agent. Human approval is handled by the approval
          // system, not by steps.
          const requested = typeof s.agentRole === "string" ? s.agentRole.trim() : "";
          const lower = requested.toLowerCase();
          const matched =
            requested.length > 0
              ? agents.find(
                  (a: any) =>
                    a.role === requested ||
                    a.name === requested ||
                    a.role?.toLowerCase() === lower ||
                    a.name?.toLowerCase() === lower ||
                    a.role?.toLowerCase().startsWith(lower) ||
                    lower.includes(String(a.name ?? "").toLowerCase()),
                )
              : undefined;
          return {
            name: s.name ?? `step_${i + 1}`,
            // Unmatched (or human) roles clamp to the first real agent —
            // an unrunnable step is worse than an imperfect assignee.
            agentRole: matched?.role ?? (agents[0]?.role || requested || "agent"),
            order: s.order ?? i + 1,
          };
        }),
      };
    }),
    config: raw?.config ?? {},
    requiredIntegrations: requiredIntegrations.length > 0 ? requiredIntegrations : undefined,
  };
}
