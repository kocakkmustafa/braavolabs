export interface CreateAbTestInput {
  companyId: string;
  agentId: string;
  name: string;
  description?: string;
  variants: { name: string; config: Record<string, any>; weight?: number }[];
}

export interface AbTestSummary {
  id: string;
  name: string;
  status: string;
  agentName: string;
  companyName: string;
  variantCount: number;
  totalRuns: number;
  startedAt: string | null;
  createdAt: string;
}

export interface AbTestDetail extends AbTestSummary {
  description: string | null;
  variants: {
    id: string;
    name: string;
    weight: number;
    config: Record<string, any>;
    metrics: { metric: string; avgValue: number; count: number }[];
    isWinner: boolean;
  }[];
}

export interface RecordAbMetricInput {
  variantId: string;
  runId?: string;
  metric: string;
  value: number;
  metadata?: Record<string, any>;
}
