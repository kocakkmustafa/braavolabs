import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { slugify } from "@ai-company-os/core";
import { PRIMITIVES, PLAN_LIMITS } from "@ai-company-os/core";

const isLocalMode = env.LLM_PROVIDER === "local";
const client = isLocalMode ? null : new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const execFileAsync = promisify(execFile);

/**
 * Call Claude via CLI or API based on LLM_PROVIDER.
 */
async function callClaude(
  systemPrompt: string,
  messages: MessageParam[],
): Promise<string> {
  if (isLocalMode) {
    // Build conversation as text for CLI
    const prompt = messages
      .map((m) => {
        const text = typeof m.content === "string"
          ? m.content
          : (m.content as any[]).map((b: any) => b.text ?? "").join("\n");
        return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
      })
      .join("\n\n");

    const { stdout } = await execFileAsync("claude", [
      "-p", prompt,
      "--output-format", "json",
      "--system-prompt", systemPrompt,
    ], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    const response = JSON.parse(stdout);
    return response.result ?? "";
  }

  // API mode
  const response = await client!.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const MAX_CLARIFICATION_TURNS = 3;

export interface BuilderSession {
  sessionId: string;
  tenantId: string;
  status: "clarifying" | "ready" | "created" | "error";
  turn: number;
  messages: MessageParam[];
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
}

const SYSTEM_PROMPT = `You are the AI Company Builder for AI Company OS.

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

// In-memory session store (will move to Redis in production)
const sessions = new Map<string, BuilderSession>();

/**
 * Start a new company building session from freeform text.
 */
export async function startBuildSession(
  tenantId: string,
  description: string,
): Promise<BuilderSession> {
  const sessionId = `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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

  const messages: MessageParam[] = [
    { role: "user", content: description },
  ];

  const assistantText = await callClaude(SYSTEM_PROMPT, messages);

  messages.push({ role: "assistant", content: assistantText });

  const parsed = parseBuilderResponse(assistantText);

  const session: BuilderSession = {
    sessionId,
    tenantId,
    status: parsed.ready ? "ready" : "clarifying",
    turn: 1,
    messages,
    companySpec: parsed.ready ? buildSpec(parsed.company) : undefined,
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
  userResponse: string,
): Promise<BuilderSession> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "clarifying") throw new Error("Session is not in clarification state");

  session.messages.push({ role: "user", content: userResponse });
  session.turn++;

  const assistantText = await callClaude(SYSTEM_PROMPT, session.messages);

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

    const finalText = await callClaude(SYSTEM_PROMPT, session.messages);

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
export async function confirmBuild(sessionId: string): Promise<BuilderSession> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "ready" || !session.companySpec) {
    throw new Error("Session is not ready for confirmation");
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

  session.status = "created";
  session.companyId = company.id;
  sessions.set(sessionId, session);

  logger.info(
    { sessionId, companyId: company.id, name: spec.name },
    "Company built successfully",
  );

  return session;
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string): BuilderSession | undefined {
  return sessions.get(sessionId);
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
  return {
    name,
    slug: slugify(name),
    description: raw?.description ?? "",
    primitives: raw?.primitives ?? ["CONTENT", "ANALYTICS"],
    agents: (raw?.agents ?? []).map((a: any) => ({
      name: a.name ?? "Agent",
      role: a.role ?? slugify(a.name ?? "agent"),
      systemPrompt:
        a.systemPrompt ??
        `You are the ${a.name ?? "Agent"} for ${name}. ${a.role ? `Your role is ${a.role}.` : ""}`,
      tools: a.tools ?? [],
    })),
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
  };
}
