export type ApprovalType = "SPEND";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface CreateApprovalInput {
  runId: string;
  type: ApprovalType;
  description: string;
  amountUsd?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
}
