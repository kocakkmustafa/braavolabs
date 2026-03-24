export type DraftType = "SOCIAL_POST" | "EMAIL" | "BLOG_POST" | "AD_COPY" | "VIDEO_SCRIPT";
export type DraftStatus = "PENDING" | "APPROVED" | "PUBLISHED" | "REJECTED" | "ARCHIVED";

export interface CreateDraftInput {
  companyId: string;
  type: DraftType;
  title: string;
  content: Record<string, unknown>;
  channel?: string;
  scheduledAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface UpdateDraftInput {
  title?: string;
  content?: Record<string, unknown>;
  status?: DraftStatus;
  channel?: string;
  scheduledAt?: Date;
}
