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
import { runWithoutTenant } from "../../lib/tenant-context";
import { env } from "../../config/env";
import { sendEmail } from "../../integrations/email";

const QUEUE_NAME = "outreach-sequence";

// Parse REDIS_URL once and forward username/password to ioredis. The
// previous version dropped credentials, which works against an unprotected
// dev redis but throws "NOAUTH Authentication required" loops the moment
// the production redis enables `requirepass`.
const _redisUrl = new URL(env.REDIS_URL);
const connection = {
  host: _redisUrl.hostname || "localhost",
  port: parseInt(_redisUrl.port || "6379"),
  ...(_redisUrl.username ? { username: decodeURIComponent(_redisUrl.username) } : {}),
  ...(_redisUrl.password ? { password: decodeURIComponent(_redisUrl.password) } : {}),
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
      data: { status: "COMPLETED" },
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
        tenantId: company.tenantId,
        action: "outreach.email_sent",
        details: { path: ["recipientEmail"], equals: contact.email },
      },
    });
    // Check if there's been a reply
    const replyCount = await prisma.activityLog.count({
      where: {
        tenantId: company.tenantId,
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
        data: { status: "COMPLETED" },
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
 *
 * concurrency=1 — outreach sends emails through SendGrid/SES, both of which
 * throttle bursts and damage sender reputation under sustained parallel
 * sends to the same recipient domain. A single-worker queue serializes
 * sends and lets the per-template/per-day caps elsewhere in the runner
 * do their job. Bump only if a real per-domain rate limiter is added.
 *
 * lockDuration=600s — outreach steps include LLM personalisation calls
 * that can take >30s; the BullMQ default lock would expire mid-call and
 * the job would be re-picked up while the original was still running.
 */
export function initOutreachWorker(): void {
  // BR-P0-004: this worker builds its Worker directly rather than through
  // createWorker (it needs a bespoke lockDuration), so it carries its own
  // system-scope marker. Behavior unchanged — no tenant context either way.
  const scopedProcessor = (job: Job<SequenceJobData>) =>
    runWithoutTenant(`worker:${QUEUE_NAME}`, () => processSequenceStep(job));

  const worker = new Worker(QUEUE_NAME, scopedProcessor, {
    connection,
    concurrency: 1,
    lockDuration: 600_000,
    stalledInterval: 60_000,
    maxStalledCount: 1,
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Outreach job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, "Outreach job failed");
  });

  logger.info("Outreach sequence worker initialized");
}
