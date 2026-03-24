/**
 * Agent Tool Registry — Faz 1
 *
 * Maps tool names to their implementations.
 * Each company's agents can only use tools registered here.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

const toolRegistry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition) {
  toolRegistry.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

// TODO: Faz 1 — Register actual tool implementations
// registerTool({ name: "generate_post", ... })
// registerTool({ name: "analyze_trends", ... })
// registerTool({ name: "create_draft", ... })
