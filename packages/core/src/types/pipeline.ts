export type PipelineTrigger = "MANUAL" | "SCHEDULED" | "WEBHOOK" | "EVENT";

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type RunStepStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "ROLLED_BACK";

export type ToolCallStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface PipelineStepDef {
  name: string;
  agentRole: string;
  order: number;
  config?: Record<string, unknown>;
}

export interface CreatePipelineInput {
  companyId: string;
  name: string;
  description?: string;
  trigger: PipelineTrigger;
  schedule?: string;
  steps: PipelineStepDef[];
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  steps: RunStepResult[];
  costUsd: number;
  durationMs: number;
}

export interface RunStepResult {
  stepIndex: number;
  name: string;
  status: RunStepStatus;
  reasoning: string;
  output: unknown;
  toolCalls: ToolCallResult[];
  costUsd: number;
}

export interface ToolCallResult {
  toolName: string;
  input: unknown;
  output: unknown;
  status: ToolCallStatus;
  durationMs: number;
}
