export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CreateAgentInput {
  companyId: string;
  name: string;
  role: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  maxTokens?: number;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  toolUse?: {
    name: string;
    input: unknown;
    output?: unknown;
  };
}

export interface AgentRunConfig {
  agentId: string;
  input: unknown;
  maxTurns?: number;
  budgetUsd?: number;
}
