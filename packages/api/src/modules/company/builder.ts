import crypto from "crypto";
import { spawn } from "node:child_process";
import { env } from "../../config/env";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { slugify } from "@ai-company-os/core";
import { PRIMITIVES, PLAN_LIMITS } from "@ai-company-os/core";
import { getTenantAIConfig, chatCompletion, type ChatMessage } from "../../services/ai-client";

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

  // API mode — use tenant's configured provider (or system default)
  const config = await getTenantAIConfig(tenantId);
  const result = await chatCompletion(config, systemPrompt, messages, 4096);
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

const SYSTEM_PROMPT = `You are the AI Company Builder for Braavoo.

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
 * Start a new company building session from freeform text.
 */
export async function startBuildSession(
  tenantId: string,
  description: string,
): Promise<BuilderSession> {
  const sessionId = `build_${crypto.randomUUID()}`;

  // Check plan limits
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { companies: { where: { status: { not: "ARCHIVED" } } } },
  });

  if (tenant) {
    const limits = PLAN_LIMITS[tenant.plan];
    if (limits.maxCompanies !== -1 && tenant.companies.length >= limits.maxCompanies) {
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
    logger.warn({ err }, "Claude API unavailable — using fallback company spec");
    // Extract a rough name from the description
    const nameMatch = description.match(/(?:called|named|company[:\s]+)\s*["']?([A-Za-z0-9 ]+)["']?/i);
    const fallbackName = nameMatch?.[1]?.trim() ?? description.slice(0, 40).trim();
    const fallbackSpec = {
      ready: true,
      company: {
        name: fallbackName || "My AI Company",
        description,
        primitives: ["CONTENT", "ACQUISITION", "ANALYTICS", "OPERATIONS"],
        agents: [
          { name: "Content Agent", role: "content_creator", systemPrompt: `You create content for ${fallbackName || "the company"}.`, tools: ["generate_post", "create_draft"] },
          { name: "Analytics Agent", role: "analyst", systemPrompt: `You analyze performance data for ${fallbackName || "the company"}.`, tools: ["get_metrics", "create_report"] },
          { name: "Operations Agent", role: "operator", systemPrompt: `You manage operations for ${fallbackName || "the company"}.`, tools: ["send_email", "update_crm"] },
        ],
        pipelines: [
          {
            name: "Daily Content Pipeline",
            trigger: "SCHEDULED",
            schedule: "0 9 * * *",
            steps: [
              { name: "Generate Content", agentRole: "content_creator", order: 1 },
              { name: "Analyze Performance", agentRole: "analyst", order: 2 },
            ],
          },
        ],
        config: {},
      },
    };
    const fallbackText = "```json\n" + JSON.stringify(fallbackSpec, null, 2) + "\n```";
    assistantText = fallbackText;
    messages.push({ role: "assistant", content: assistantText });
    parsed = fallbackSpec as BuilderOutput;
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

  // Create company
  const company = await prisma.company.create({
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

  // Create agents
  for (const agentDef of spec.agents) {
    await prisma.agent.create({
      data: {
        companyId: company.id,
        name: agentDef.name,
        role: agentDef.role,
        systemPrompt: agentDef.systemPrompt,
        tools: agentDef.tools,
      },
    });
  }

  // Create pipelines
  for (const pipelineDef of spec.pipelines) {
    await prisma.pipeline.create({
      data: {
        companyId: company.id,
        name: pipelineDef.name,
        trigger: pipelineDef.trigger as any,
        schedule: pipelineDef.schedule,
        steps: pipelineDef.steps as any,
      },
    });
  }

  // Activity log
  await prisma.activityLog.create({
    data: {
      tenantId: session.tenantId,
      actor: "company_builder",
      action: "company.build",
      resource: "company",
      resourceId: company.id,
      details: {
        sessionId,
        turns: session.turn,
        primitives: spec.primitives,
        agentCount: spec.agents.length,
        pipelineCount: spec.pipelines.length,
      },
    },
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
    pipelines: (raw?.pipelines ?? []).map((p: any) => ({
      name: p.name ?? "Default Pipeline",
      trigger: p.trigger ?? "MANUAL",
      schedule: p.schedule,
      steps: (p.steps ?? []).map((s: any, i: number) => ({
        name: s.name ?? `step_${i + 1}`,
        agentRole: s.agentRole ?? "agent",
        order: s.order ?? i + 1,
      })),
    })),
    config: raw?.config ?? {},
    requiredIntegrations: requiredIntegrations.length > 0 ? requiredIntegrations : undefined,
  };
}
