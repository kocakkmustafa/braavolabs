/**
 * Outreach Sequence Runner — BullMQ worker that processes
 * outreach enrollment steps on a schedule.
 *
 * Each enrollment progresses through sequence steps with
 * configurable delays (1-7 days between steps).
 */

import { Queue, Worker, type Job } from "bullmq";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { sendEmail } from "../../integrations/email";

const QUEUE_NAME = "outreach-sequence";

const connection = {
  host: new URL(env.REDIS_URL).hostname || "localhost",
  port: parseInt(new URL(env.REDIS_URL).port || "6379"),
};

export const outreachQueue = new Queue(QUEUE_NAME, { connection });

interface SequenceJobData {
  enrollmentId: string;
}

/**
 * Enqueue the next step for an enrollment.
 */
export async function scheduleNextStep(
  enrollmentId: string,
  delayMs: number,
): Promise<void> {
  await outreachQueue.add(
    "process-step",
    { enrollmentId },
    { delay: delayMs, removeOnComplete: 100, removeOnFail: 50 },
  );
  logger.info({ enrollmentId, delayMs }, "Outreach step scheduled");
}

/**
 * Process an enrollment step.
 */
async function processSequenceStep(job: Job<SequenceJobData>): Promise<void> {
  const { enrollmentId } = job.data;

  const enrollment = await prisma.outreachEnrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      sequence: { include: { company: true } },
      contact: true,
    },
  });

  if (!enrollment) {
    logger.warn({ enrollmentId }, "Enrollment not found — skipping");
    return;
  }

  if (enrollment.status !== "ACTIVE") {
    logger.info({ enrollmentId, status: enrollment.status }, "Enrollment not active — skipping");
    return;
  }

  const steps = enrollment.sequence.steps as Array<{
    type: string;
    subject?: string;
    body: string;
    delayDays: number;
  }>;

  const currentStep = enrollment.currentStep;
  if (currentStep >= steps.length) {
    // Sequence completed
    await prisma.outreachEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    logger.info({ enrollmentId }, "Outreach sequence completed");
    return;
  }

  const step = steps[currentStep];
  const contact = enrollment.contact;
  const company = enrollment.sequence.company;

  // --- Spam check: max 3 unanswered sends to same email ---
  if (contact.email) {
    const unansweredCount = await prisma.activityLog.count({
      where: {
        companyId: company.id,
        action: "outreach.email_sent",
        details: { path: ["recipientEmail"], equals: contact.email },
      },
    });
    // Check if there's been a reply
    const replyCount = await prisma.activityLog.count({
      where: {
        companyId: company.id,
        action: "outreach.reply_received",
        details: { path: ["contactEmail"], equals: contact.email },
      },
    });

    if (unansweredCount - replyCount >= 3) {
      logger.warn({ enrollmentId, email: contact.email }, "Spam protection: 3+ unanswered emails — stopping sequence");
      await prisma.outreachEnrollment.update({
        where: { id: enrollmentId },
        data: { status: "COMPLETED" },
      });
      await prisma.activityLog.create({
        data: {
          tenantId: company.tenantId,
          companyId: company.id,
          actor: "system",
          action: "outreach.spam_stop",
          resource: "enrollment",
          resourceId: enrollmentId,
          details: { reason: "3+ unanswered emails", contactEmail: contact.email },
        },
      });
      return;
    }
  }

  // --- Send the step ---
  try {
    if (step.type === "email" && contact.email) {
      await sendEmail({
        to: contact.email,
        subject: step.subject ?? `Message from ${company.name}`,
        body: interpolateTemplate(step.body, {
          contactName: contact.name ?? "",
          companyName: company.name,
        }),
      });
    }
    // LinkedIn/X DM would be draft-based in V1

    // Log activity
    await prisma.activityLog.create({
      data: {
        tenantId: company.tenantId,
        companyId: company.id,
        actor: "system",
        action: "outreach.email_sent",
        resource: "enrollment",
        resourceId: enrollmentId,
        details: {
          step: currentStep,
          recipientEmail: contact.email,
          subject: step.subject,
        },
      },
    });

    // Advance step
    await prisma.outreachEnrollment.update({
      where: { id: enrollmentId },
      data: { currentStep: currentStep + 1 },
    });

    // Schedule next step if available
    if (currentStep + 1 < steps.length) {
      const nextStep = steps[currentStep + 1];
      const delayMs = (nextStep.delayDays ?? 3) * 24 * 60 * 60 * 1000;
      await scheduleNextStep(enrollmentId, delayMs);
    } else {
      await prisma.outreachEnrollment.update({
        where: { id: enrollmentId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }

    logger.info({ enrollmentId, step: currentStep }, "Outreach step processed");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ enrollmentId, step: currentStep, error }, "Outreach step failed");

    // Check for bounce
    if (error.includes("bounce") || error.includes("invalid")) {
      await prisma.outreachEnrollment.update({
        where: { id: enrollmentId },
        data: { status: "BOUNCED" },
      });
    }
  }
}

/**
 * Simple template interpolation: {{variable}} → value.
 */
function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Initialize the outreach sequence worker.
 */
export function initOutreachWorker(): void {
  const worker = new Worker(QUEUE_NAME, processSequenceStep, {
    connection,
    concurrency: 5,
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Outreach job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, "Outreach job failed");
  });

  logger.info("Outreach sequence worker initialized");
}
