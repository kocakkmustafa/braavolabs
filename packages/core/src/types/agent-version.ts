export interface AgentVersionSummary {
  id: string;
  version: number;
  label: string | null;
  changeSummary: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AgentVersionDetail extends AgentVersionSummary {
  snapshot: Record<string, any>;
}

export interface AgentDiff {
  field: string;
  oldValue: any;
  newValue: any;
}

export interface CreateVersionInput {
  label?: string;
  changeSummary?: string;
}

export interface RollbackInput {
  targetVersion: number;
}
