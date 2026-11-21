/**
 * Spam guard (CLAUDE.md rule 6): >=3 unanswered outreach stops the contact.
 *
 * One threshold, one comparison, two counters for the two entry points:
 *  - sequence runner: unanswered SENDS to an address (activity_log
 *    `outreach.email_sent` minus `outreach.reply_received`);
 *  - enroll endpoint: ACTIVE, unreplied ENROLLMENTS of a contact.
 * Both previously inlined their own `>= 3`; results are unchanged.
 */
import { prisma } from "./db";

export const SPAM_GUARD_LIMIT = 3;

export function isSpamLimitReached(unanswered: number): boolean {
  return unanswered >= SPAM_GUARD_LIMIT;
}

export async function countUnansweredSends(tenantId: string, email: string): Promise<number> {
  const sent = await prisma.activityLog.count({
    where: {
      tenantId,
      action: "outreach.email_sent",
      details: { path: ["recipientEmail"], equals: email },
    },
  });
  const replies = await prisma.activityLog.count({
    where: {
      tenantId,
      action: "outreach.reply_received",
      details: { path: ["contactEmail"], equals: email },
    },
  });
  return sent - replies;
}

export async function countActiveUnansweredEnrollments(tenantId: string, contactId: string): Promise<number> {
  return prisma.outreachEnrollment.count({
    where: {
      contactId,
      status: "ACTIVE",
      repliedAt: null,
      sequence: { company: { tenantId } },
    },
  });
}
