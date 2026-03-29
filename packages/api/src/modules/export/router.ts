/**
 * Export Module — Company-to-Claude-Code Export
 *
 * Allows users to export their AI companies as:
 * 1. Claude Code compatible CLAUDE.md project file
 * 2. Skills (slash commands) for each agent
 * 3. Hooks for pipeline triggers
 * 4. Full configuration bundle (ZIP-ready JSON)
 *
 * Export formats support: Claude Code, OpenClaw, NemoClaw
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";

export const exportRouter = Router();
exportRouter.use(authMiddleware);

/**
 * GET /api/v1/export/:companyId/claude-md
 * Generate a CLAUDE.md file for the company
 */
exportRouter.get("/:companyId/claude-md", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
      include: {
        agents: true,
        pipelines: true,
      },
    });

    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const claudeMd = generateClaudeMd(company);
    res.setHeader("Content-Type", "text/markdown");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CLAUDE.md"`,
    );
    res.send(claudeMd);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/export/:companyId/skills
 * Export agents as Claude Code skill files
 */
exportRouter.get("/:companyId/skills", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
      include: { agents: true, pipelines: true },
    });

    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const skills = generateSkills(company);
    res.json({ companyName: company.name, skills });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/export/:companyId/hooks
 * Export pipeline triggers as Claude Code hooks
 */
exportRouter.get("/:companyId/hooks", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
      include: { pipelines: true },
    });

    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const hooks = generateHooks(company);
    res.json({ companyName: company.name, hooks });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/export/:companyId/bundle
 * Full export bundle (CLAUDE.md + skills + hooks + config)
 */
exportRouter.get("/:companyId/bundle", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
      include: {
        agents: true,
        pipelines: true,
      },
    });

    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const format = (req.query.format as string) || "claude-code";

    const bundle = {
      meta: {
        exportedAt: new Date().toISOString(),
        format,
        version: "1.0.0",
        platform: "ai-company-os",
      },
      company: {
        name: company.name,
        slug: company.slug,
        description: company.description,
        primitives: company.primitives,
        config: company.config,
      },
      claudeMd: generateClaudeMd(company),
      skills: generateSkills(company),
      hooks: generateHooks(company),
      settings: generateSettings(company, format),
    };

    // Log export activity
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.export",
        resource: "company",
        resourceId: company.id,
        details: { format, agentCount: company.agents.length },
      },
    });

    res.json(bundle);
  } catch (err) {
    next(err);
  }
});

// ─── Generator Functions ────────────────────────────────────

function generateClaudeMd(company: any): string {
  const agents = company.agents || [];
  const pipelines = company.pipelines || [];
  const config = (company.config as Record<string, any>) || {};

  return `# CLAUDE.md — ${company.name}

## Company Overview
${company.description || "AI-powered autonomous company."}

**Primitives:** ${(company.primitives as string[]).join(", ")}
**Status:** ${company.status}

## Agents

${agents
  .map(
    (a: any) => `### ${a.name} (${a.role})
**System Prompt:**
${a.systemPrompt}

**Tools:** ${(a.tools as string[]).join(", ")}
`,
  )
  .join("\n")}

## Pipelines

${pipelines
  .map(
    (p: any) => `### ${p.name}
- **Trigger:** ${p.trigger}${p.schedule ? ` (${p.schedule})` : ""}
- **Steps:**
${(p.steps as any[])
  .sort((a: any, b: any) => a.order - b.order)
  .map((s: any) => `  ${s.order}. ${s.name} → agent: ${s.agentRole}`)
  .join("\n")}
`,
  )
  .join("\n")}

## Configuration
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Rules
- Every action must be logged with reasoning
- Spend actions require human approval
- Content must pass quality review (score >= 70) before publishing
- Memory lifecycle: candidate → approved → deprecated
- No single-example generalization

---
*Exported from AI Company OS — ${new Date().toISOString()}*
`;
}

function generateSkills(company: any): Array<{
  fileName: string;
  name: string;
  description: string;
  content: string;
}> {
  const agents = company.agents || [];
  const skills: Array<{
    fileName: string;
    name: string;
    description: string;
    content: string;
  }> = [];

  for (const agent of agents) {
    const slug = (agent.role as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const tools = (agent.tools as string[]) || [];

    skills.push({
      fileName: `${slug}.md`,
      name: agent.name,
      description: `${agent.name} — ${agent.role} skill for ${company.name}`,
      content: `---
name: ${agent.name}
description: ${agent.role} agent for ${company.name}
---

# ${agent.name}

## Role
${agent.role}

## System Prompt
${agent.systemPrompt}

## Available Tools
${tools.map((t: string) => `- \`${t}\``).join("\n")}

## Behavior Rules
1. Always explain your reasoning before taking action
2. Log every decision with a "why" explanation
3. If unsure, ask for clarification rather than guessing
4. Track costs and stay within budget
5. Follow the company's brand voice and guidelines

## Integration
This skill connects to the AI Company OS API at \`$AICOS_API_URL\`.
Use the following headers:
\`\`\`
Authorization: Bearer $AICOS_TOKEN
Content-Type: application/json
\`\`\`
`,
    });
  }

  // Add a master orchestrator skill
  skills.push({
    fileName: "orchestrator.md",
    name: `${company.name} Orchestrator`,
    description: `Master orchestrator for ${company.name}`,
    content: `---
name: ${company.name} Orchestrator
description: Coordinates all agents and pipelines for ${company.name}
---

# ${company.name} — Orchestrator

## Overview
${company.description || "AI-powered autonomous company."}

## Available Agents
${agents.map((a: any) => `- **${a.name}** (${a.role}): ${(a.tools as string[]).join(", ")}`).join("\n")}

## Workflow
${(company.pipelines || [])
  .map(
    (p: any) =>
      `### ${p.name} (${p.trigger}${p.schedule ? ` — ${p.schedule}` : ""})
${(p.steps as any[])
  .sort((a: any, b: any) => a.order - b.order)
  .map((s: any) => `${s.order}. ${s.name} → ${s.agentRole}`)
  .join("\n")}`,
  )
  .join("\n\n")}

## Governance Rules
- Spend actions require approval
- Max 3 outreach attempts per target
- Cost anomaly detection enabled
- All actions logged to audit trail
`,
  });

  return skills;
}

function generateHooks(company: any): Array<{
  fileName: string;
  event: string;
  description: string;
  content: string;
}> {
  const pipelines = company.pipelines || [];
  const hooks: Array<{
    fileName: string;
    event: string;
    description: string;
    content: string;
  }> = [];

  for (const pipeline of pipelines) {
    if (pipeline.trigger === "SCHEDULED" && pipeline.schedule) {
      hooks.push({
        fileName: `hook-${(pipeline.name as string).replace(/[^a-z0-9]+/g, "-")}.sh`,
        event: "cron",
        description: `Trigger ${pipeline.name} on schedule: ${pipeline.schedule}`,
        content: `#!/bin/bash
# Hook: ${pipeline.name}
# Schedule: ${pipeline.schedule}
# Auto-trigger pipeline via AI Company OS API

AICOS_API_URL="\${AICOS_API_URL:-http://localhost:8080/api/v1}"
PIPELINE_ID="${pipeline.id}"

curl -s -X POST "\$AICOS_API_URL/pipelines/\$PIPELINE_ID/run" \\
  -H "Authorization: Bearer \$AICOS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{}' | jq .
`,
      });
    }

    if (pipeline.trigger === "WEBHOOK") {
      hooks.push({
        fileName: `hook-${(pipeline.name as string).replace(/[^a-z0-9]+/g, "-")}.sh`,
        event: "webhook",
        description: `Webhook handler for ${pipeline.name}`,
        content: `#!/bin/bash
# Hook: ${pipeline.name} (Webhook)
# Listens for external events and triggers pipeline

AICOS_API_URL="\${AICOS_API_URL:-http://localhost:8080/api/v1}"
COMPANY_SLUG="${company.slug}"
EVENT_NAME="${(pipeline.name as string).replace(/_/g, "-")}"

# Trigger via webhook endpoint:
# POST \$AICOS_API_URL/../hooks/\$COMPANY_SLUG/\$EVENT_NAME
curl -s -X POST "http://localhost:8080/hooks/\$COMPANY_SLUG/\$EVENT_NAME" \\
  -H "Content-Type: application/json" \\
  -d '{"source": "claude-code", "event": "'"$EVENT_NAME"'"}' | jq .
`,
      });
    }
  }

  return hooks;
}

function generateSettings(company: any, format: string): Record<string, any> {
  const agents = company.agents || [];

  if (format === "claude-code") {
    return {
      "settings.json": {
        permissions: {
          allow: [
            "Bash(curl:*)",
            "Bash(jq:*)",
          ],
        },
        env: {
          AICOS_API_URL: "http://localhost:8080/api/v1",
          AICOS_COMPANY_ID: company.id,
          AICOS_COMPANY_SLUG: company.slug,
        },
      },
      "mcp.json": {
        mcpServers: {
          "ai-company-os": {
            command: "node",
            args: ["./mcp-bridge.js"],
            env: {
              AICOS_API_URL: "http://localhost:8080/api/v1",
            },
          },
        },
      },
    };
  }

  if (format === "n8n") {
    return {
      workflows: (company.pipelines || []).map((p: any) => ({
        name: p.name,
        trigger: p.trigger,
        schedule: p.schedule,
        nodes: (p.steps as any[]).map((s: any) => ({
          type: "httpRequest",
          name: s.name,
          parameters: {
            url: `\${AICOS_API_URL}/pipelines/${p.id}/run`,
            method: "POST",
            headers: { Authorization: "Bearer ${AICOS_TOKEN}" },
          },
        })),
      })),
    };
  }

  // Generic format
  return {
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      agents: agents.map((a: any) => ({
        name: a.name,
        role: a.role,
        tools: a.tools,
      })),
    },
  };
}
