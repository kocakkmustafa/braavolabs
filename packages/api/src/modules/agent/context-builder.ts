/**
 * Context Builder — assembles the optimal context window for agent prompts.
 *
 * Strategy: pointer + retrieval (don't dump everything, load what's relevant).
 * 1. System prompt: agent role, rules, tool list
 * 2. Company context: company.config relevant slice
 * 3. Memory context: last 5 episodic + relevant semantic memories
 * 4. Current task context: pipeline step input
 * 5. Recent activity: last 10 activity_log entries
 */

import { prisma } from "../../lib/db";

interface ContextConfig {
  companyId: string;
  agentRole: string;
  agentSystemPrompt: string;
  taskDescription: string;
  stepInput?: unknown;
  toolNames: string[];
}

export interface BuiltContext {
  systemPrompt: string;
  userMessage: string;
}

/**
 * Build full context for an agent execution.
 */
export async function buildAgentContext(config: ContextConfig): Promise<BuiltContext> {
  const [company, recentMemories, recentActivity] = await Promise.all([
    prisma.company.findUnique({
      where: { id: config.companyId },
      select: {
        name: true,
        description: true,
        primitives: true,
        config: true,
        status: true,
      },
    }),
    fetchRecentMemories(config.companyId),
    fetchRecentActivity(config.companyId),
  ]);

  // --- System Prompt ---
  const systemParts = [
    config.agentSystemPrompt,
    "",
    "## Company Context",
    `Company: ${company?.name ?? "Unknown"}`,
    `Status: ${company?.status ?? "UNKNOWN"}`,
    company?.description ? `Description: ${company.description}` : "",
    company?.primitives
      ? `Active Primitives: ${JSON.stringify(company.primitives)}`
      : "",
  ];

  // Company config (relevant slice only)
  if (company?.config && typeof company.config === "object") {
    const cfg = company.config as Record<string, unknown>;
    const relevantKeys = ["brand_voice", "icp", "channels", "work_mode", "kpi", "budget"];
    const relevant = Object.fromEntries(
      Object.entries(cfg).filter(([k]) => relevantKeys.includes(k)),
    );
    if (Object.keys(relevant).length > 0) {
      systemParts.push("", "## Company Configuration", JSON.stringify(relevant, null, 2));
    }
  }

  // Available tools
  if (config.toolNames.length > 0) {
    systemParts.push(
      "",
      "## Available Tools",
      `You have access to: ${config.toolNames.join(", ")}`,
    );
  }

  // Rules
  systemParts.push(
    "",
    "## Mandatory Rules",
    "1. ALWAYS explain your reasoning for every decision in a '## Reasoning' section.",
    "2. Every tool call is logged and audited.",
    "3. If a tool requires approval (spend/publish), the system will pause for human review.",
    "4. Never send the same message to the same recipient more than 3 times without a reply.",
    "5. Stay within the company's brand voice and guidelines.",
  );

  // --- User Message ---
  const userParts = [config.taskDescription];

  if (config.stepInput && typeof config.stepInput === "object" && Object.keys(config.stepInput as object).length > 0) {
    userParts.push("", "## Input from Previous Step", JSON.stringify(config.stepInput, null, 2));
  }

  // Memory context
  if (recentMemories.length > 0) {
    userParts.push("", "## Relevant Memories");
    for (const mem of recentMemories) {
      userParts.push(
        `- [${mem.type}/${mem.status}] ${mem.content} (confidence: ${mem.confidence})`,
      );
    }
  }

  // Recent activity
  if (recentActivity.length > 0) {
    userParts.push("", "## Recent Activity (last 10)");
    for (const act of recentActivity) {
      userParts.push(
        `- ${act.createdAt.toISOString().slice(0, 16)} | ${act.action} | ${act.resource ?? ""} ${act.resourceId ?? ""}`,
      );
    }
  }

  return {
    systemPrompt: systemParts.filter(Boolean).join("\n"),
    userMessage: userParts.join("\n"),
  };
}

async function fetchRecentMemories(companyId: string) {
  return prisma.memoryItem.findMany({
    where: {
      companyId,
      status: { in: ["CANDIDATE", "APPROVED"] },
    },
    orderBy: [{ status: "desc" }, { lastUsedAt: "desc" }, { createdAt: "desc" }],
    take: 10,
    select: {
      type: true,
      status: true,
      content: true,
      confidence: true,
    },
  });
}

async function fetchRecentActivity(companyId: string) {
  return prisma.activityLog.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      action: true,
      resource: true,
      resourceId: true,
      createdAt: true,
    },
  });
}
