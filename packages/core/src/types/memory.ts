export type MemoryType = "EPISODIC" | "SEMANTIC" | "PROCEDURAL";
export type MemoryStatus = "CANDIDATE" | "APPROVED" | "DEPRECATED";

export interface CreateMemoryInput {
  companyId: string;
  type: MemoryType;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
  confidence?: number;
}

export interface MemorySearchInput {
  companyId: string;
  query: string;
  type?: MemoryType;
  status?: MemoryStatus;
  limit?: number;
  minConfidence?: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: number;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface MemoryEdgeInput {
  fromId: string;
  toId: string;
  relation: string;
  weight?: number;
}
