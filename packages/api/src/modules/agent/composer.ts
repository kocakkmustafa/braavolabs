/**
 * AI Agent Composer
 *
 * Takes a user's plain-English description and returns a complete agent
 * specification (name, role, systemPrompt, tools) using the tenant's
 * configured LLM (BYOK Claude / OpenAI / Gemini / Groq / Ollama / etc.).
 *
 * Security boundary: the LLM only chooses from the registered tool
 * whitelist. Any tool name it hallucinates is dropped during validation
 * and surfaced back to the user as "skipped: <name>". The agent itself
 * still runs through the same governance + sandbox at execution time —
 * composing it just generates the prompt and tool selection.
 */
import { z } from "zod";
import { getTool, getToolNames } from "./registry";
import { chatCompletion, getTenantAIConfig, type ChatMessage } from "../../services/ai-client";
import { logger } from "../../lib/logger";

export const ComposedAgentSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, "role must be snake_case"),
  systemPrompt: z.string().min(20).max(8000),
  tools: z.array(z.string()).max(20),
});

export type ComposedAgent = z.infer<typeof ComposedAgentSchema>;

export interface ComposeResult {
  agent: ComposedAgent;
  /** Tool names the LLM asked for that don't exist in our registry. */
  droppedTools: string[];
  /** Token usage from the LLM call. */
  inputTokens: number;
  outputTokens: number;
  /** Provider + model used (for billing + observability). */
  provider: string;
  model: string;
}

/**
 * Build the tool catalog block for the system prompt.
 * Compact format: "- name: short description" — keeps prompt token count
 * manageable even with 30+ tools.
 */
function buildToolCatalog(): string {
  const names = getToolNames().sort();
  return names
    .map((name) => {
      const tool = getTool(name);
      if (!tool) return null;
      // Truncate long descriptions to keep the catalog scannable.
      const desc = tool.description.replace(/\s+/g, " ").trim();
      const short = desc.length > 180 ? desc.slice(0, 177) + "..." : desc;
      return `- ${name}: ${short}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n");
}

const SYSTEM_PROMPT = (toolCatalog: string) => `You are an expert at designing AI agent specifications for the Braavolabs autonomous company platform.

The user will describe what they want an agent to do. Your job is to write a complete, production-ready agent specification.

## CONSTRAINTS

1. Use ONLY tools from the AVAILABLE TOOLS list below. Do NOT invent or reference any tool not on the list.
2. The "role" field must be snake_case (e.g. "content_creator", "sales_outreach", "memory_curator") — letters, digits, and underscores only, starting with a letter.
3. The "systemPrompt" must be a complete operating manual: who the agent is, what it should do, what it must NOT do, output format, edge cases. Aim for 200-1500 words.
4. Pick the smallest tool set that does the job. An agent with 3 well-chosen tools is better than one with 10 unused ones.
5. Output MUST be valid JSON matching the schema below — no markdown, no code fences, no explanation, no preamble. Just the JSON object.

## OUTPUT JSON SCHEMA

{
  "name": string,           // 2-6 words, human-readable, Title Case (e.g. "Content Creator", "Sales Outreach Bot")
  "role": string,           // snake_case identifier (e.g. "content_creator")
  "systemPrompt": string,   // full instructions for the agent
  "tools": string[]         // tool names from the AVAILABLE TOOLS list
}

## AVAILABLE TOOLS

${toolCatalog}

## RULES OF ENGAGEMENT

- If the user's request is ambiguous, make reasonable assumptions and proceed — do NOT ask for clarification, just deliver the spec.
- If a tool the user implicitly wants is missing (e.g. they mention Instagram but no instagram tool is registered), pick the closest available tool and reflect this in the systemPrompt.
- Always include a "Spend approval" reminder in the systemPrompt for any agent that touches money or external sends.
- Always include "log every decision in plain English" instruction (Braavolabs requires reasoning on every step).

Now write the agent specification.`;

/**
 * Pull a JSON object out of the LLM's reply. LLMs occasionally wrap
 * responses in code fences (```json ... ```) or add prose preambles even
 * when told not to. We try the strictest parse first, then progressively
 * looser fallbacks before failing.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  // Fast path — clean JSON.
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Strip markdown code fences (```json ... ``` or ``` ... ```).
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }

  // Last-ditch: find the first balanced { ... } in the body.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  throw new Error(`Could not parse JSON from LLM reply (length=${raw.length}). First 200 chars: ${raw.slice(0, 200)}`);
}

/**
 * Compose a new agent specification from a plain-English description.
 *
 * Calls the tenant's configured LLM (BYOK), enforces the tool whitelist,
 * and returns a validated ComposedAgent ready to be persisted.
 *
 * Throws on:
 *   - missing AI config (no BYOK key + no system fallback)
 *   - LLM timeout / API error
 *   - JSON parse failure after all fallbacks
 *   - schema validation failure (Zod)
 */
export async function composeAgent(
  tenantId: string,
  description: string,
): Promise<ComposeResult> {
  if (description.trim().length < 10) {
    throw new Error("Description must be at least 10 characters.");
  }
  if (description.length > 4000) {
    throw new Error("Description is too long (max 4000 characters).");
  }

  const aiConfig = await getTenantAIConfig(tenantId);
  const toolCatalog = buildToolCatalog();
  const systemPrompt = SYSTEM_PROMPT(toolCatalog);
  const messages: ChatMessage[] = [{ role: "user", content: description.trim() }];

  logger.info(
    { tenantId, provider: aiConfig.provider, model: aiConfig.model, descLen: description.length },
    "Composing agent via LLM",
  );

  const result = await chatCompletion(aiConfig, systemPrompt, messages, 4096);

  let parsed: unknown;
  try {
    parsed = extractJson(result.content);
  } catch (err) {
    logger.warn({ tenantId, replyLen: result.content.length }, "Composer JSON extract failed");
    throw new Error(
      `LLM did not return valid JSON. The provider may not support strict JSON output — try Claude or GPT-4o instead. (${err instanceof Error ? err.message : "parse error"})`,
    );
  }

  const validated = ComposedAgentSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    logger.warn({ tenantId, issues }, "Composer schema validation failed");
    throw new Error(`LLM produced invalid agent spec: ${issues}`);
  }

  // Tool whitelist enforcement — drop any tool the LLM hallucinated that
  // isn't actually registered. This is the security boundary: even if the
  // LLM is jailbroken or confused, it cannot smuggle a fake tool name in.
  const registered = new Set(getToolNames());
  const requestedTools = validated.data.tools;
  const allowedTools: string[] = [];
  const droppedTools: string[] = [];
  for (const t of requestedTools) {
    if (registered.has(t)) {
      allowedTools.push(t);
    } else {
      droppedTools.push(t);
    }
  }

  if (droppedTools.length > 0) {
    logger.info(
      { tenantId, droppedTools, kept: allowedTools.length },
      "Composer dropped unregistered tools",
    );
  }

  return {
    agent: { ...validated.data, tools: allowedTools },
    droppedTools,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    provider: result.provider,
    model: result.model,
  };
}
