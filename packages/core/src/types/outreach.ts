export type OutreachChannel = "EMAIL" | "LINKEDIN" | "TWITTER" | "TIKTOK";
export type EnrollmentStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "UNSUBSCRIBED" | "BOUNCED";

export interface OutreachStepDef {
  order: number;
  channel: OutreachChannel;
  template: string;
  delayHours: number;
  subject?: string;
}

export interface CreateSequenceInput {
  companyId: string;
  name: string;
  channel: OutreachChannel;
  steps: OutreachStepDef[];
}

export interface EnrollContactInput {
  sequenceId: string;
  contactId: string;
}
