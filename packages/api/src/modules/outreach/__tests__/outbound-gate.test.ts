/**
 * B-06 — outreach sequences stay OFF on the server until
 * OUTREACH_SEQUENCES_ENABLED=true (and the worker also needs
 * OUTBOUND_EMAIL_ENABLED=true before it may email a contact).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const companyFindFirst = vi.hoisted(() => vi.fn());
const sequenceCreate = vi.hoisted(() => vi.fn());
const sequenceFindUnique = vi.hoisted(() => vi.fn());
const contactFindFirst = vi.hoisted(() => vi.fn());
const enrollmentCount = vi.hoisted(() => vi.fn());
const enrollmentCreate = vi.hoisted(() => vi.fn());
const enrollmentFindUnique = vi.hoisted(() => vi.fn());
const enrollmentUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const activityLogCount = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const queueAdd = vi.hoisted(() => vi.fn());
const suppressionFindFirst = vi.hoisted(() => vi.fn());
const enrollmentUpdateMany = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    outreachSequence: {
      create: (...a: unknown[]) => sequenceCreate(...a),
      findUnique: (...a: unknown[]) => sequenceFindUnique(...a),
    },
    contact: { findFirst: (...a: unknown[]) => contactFindFirst(...a) },
    outreachEnrollment: {
      count: (...a: unknown[]) => enrollmentCount(...a),
      create: (...a: unknown[]) => enrollmentCreate(...a),
      findUnique: (...a: unknown[]) => enrollmentFindUnique(...a),
      update: (...a: unknown[]) => enrollmentUpdate(...a),
      updateMany: (...a: unknown[]) => enrollmentUpdateMany(...a),
    },
    emailSuppression: {
      findFirst: (...a: unknown[]) => suppressionFindFirst(...a),
      upsert: vi.fn(),
    },
    activityLog: {
      create: (...a: unknown[]) => activityLogCreate(...a),
      count: (...a: unknown[]) => activityLogCount(...a),
    },
  },
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../config/env", () => ({
  env: {
    REDIS_URL: "redis://127.0.0.1:1",
    JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-xx",
    API_PUBLIC_URL: "https://api.example.test",
  },
}));
vi.mock("../../../integrations/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("bullmq", () => ({
  Queue: class { add = (...a: unknown[]) => queueAdd(...a); },
  Worker: class { on() {} },
}));

import { outreachRouter } from "../router";
import { processSequenceStep } from "../sequence-runner";

function handler(path: string) {
  const layer = (outreachRouter as Router & { stack: any[] }).stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.post,
  );
  if (!layer) throw new Error(`Outreach POST ${path} missing`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: (error?: any) => void) => Promise<void>;
}

async function invoke(path: string, body: Record<string, unknown>, params: Record<string, string> = {}) {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), json };
  let error: any;
  await handler(path)(
    { params, body, auth: { tenantId: "tenant-1", userId: "user-1" } },
    res,
    (nextError?: any) => { error = nextError; },
  );
  return { res, json, error };
}

const sequenceBody = {
  companyId: "company-1",
  name: "Seq",
  channel: "EMAIL",
  steps: [{ order: 0, channel: "EMAIL", template: "Hi", delayHours: 0 }],
};

function activeEnrollment() {
  return {
    id: "enr-1",
    status: "ACTIVE",
    currentStep: 0,
    contact: { email: "lead@example.test", name: "Lead" },
    sequence: {
      steps: [{ type: "email", subject: "Hello", body: "Hi {{contactName}}", delayDays: 1 }],
      company: { tenantId: "tenant-1", name: "Acme" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  companyFindFirst.mockResolvedValue({ id: "company-1" });
  sequenceCreate.mockResolvedValue({ id: "seq-1" });
  sequenceFindUnique.mockResolvedValue({ id: "seq-1", company: { tenantId: "tenant-1" } });
  contactFindFirst.mockResolvedValue({ id: "contact-1", companyId: "company-1" });
  enrollmentCount.mockResolvedValue(0);
  enrollmentCreate.mockResolvedValue({ id: "enr-1" });
  enrollmentFindUnique.mockResolvedValue(activeEnrollment());
  enrollmentUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  activityLogCount.mockResolvedValue(0);
  sendEmail.mockResolvedValue({ messageId: "sg-1" });
  vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
  suppressionFindFirst.mockResolvedValue(null);
  enrollmentUpdateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("outreach API — B-06 gate", () => {
  it.each([undefined, "false"])("OUTREACH_SEQUENCES_ENABLED=%s refuses sequence create with 422", async (value) => {
    if (value === undefined) delete process.env.OUTREACH_SEQUENCES_ENABLED;
    const { error, json } = await invoke("/sequences", sequenceBody);
    expect(error).toMatchObject({ statusCode: 422, code: "OUTREACH_SEQUENCES_DISABLED" });
    expect(json).not.toHaveBeenCalled();
    expect(sequenceCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("refuses enrollment with 422 before touching the contact", async () => {
    const { error } = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(error).toMatchObject({ statusCode: 422, code: "OUTREACH_SEQUENCES_DISABLED" });
    expect(sequenceFindUnique).not.toHaveBeenCalled();
    expect(enrollmentCreate).not.toHaveBeenCalled();
  });

  it("keeps unsubscribe available while disabled", async () => {
    enrollmentFindUnique.mockResolvedValue({ id: "enr-1", sequence: { company: { tenantId: "tenant-1" } } });
    const { error, json } = await invoke("/enrollments/:id/unsubscribe", {}, { id: "enr-1" });
    expect(error).toBeUndefined();
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(enrollmentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNSUBSCRIBED" }),
    }));
  });

  it("restores create and enroll when the flag is \"true\"", async () => {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    const created = await invoke("/sequences", sequenceBody);
    expect(created.error).toBeUndefined();
    expect(created.res.status).toHaveBeenCalledWith(201);
    expect(sequenceCreate).toHaveBeenCalledOnce();

    const enrolled = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(enrolled.error).toBeUndefined();
    expect(enrolled.res.status).toHaveBeenCalledWith(201);
    expect(enrollmentCreate).toHaveBeenCalledOnce();
  });
});

describe("outreach worker — B-06 gate", () => {
  const job = { data: { enrollmentId: "enr-1" } } as any;

  it.each([
    ["false", "false"],
    ["true", "false"],
    ["false", "true"],
  ])("outreach=%s email=%s consumes the step without sending or advancing", async (outreach, email) => {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", outreach);
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", email);
    await processSequenceStep(job);
    expect(enrollmentFindUnique).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(enrollmentUpdate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  function enableAll(withLegal = true) {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    if (withLegal) {
      vi.stubEnv("OUTBOUND_LEGAL_SENDER_ADDRESS", "Test Street 1, Test City");
      vi.stubEnv("OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT", "Opt out here: {url}");
    }
  }

  it("restores the previous step processing when both flags and the legal config are set", async () => {
    enableAll();
    await processSequenceStep(job);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "lead@example.test",
      subject: "Hello",
      body: expect.stringMatching(/^Hi Lead<hr>/),
      outbound: { tenantId: "tenant-1" },
    }));
    expect(enrollmentUpdate).toHaveBeenCalledWith({ where: { id: "enr-1" }, data: { currentStep: 1 } });
  });

  it("appends the opt-out link and the sender address from config", async () => {
    enableAll();
    await processSequenceStep(job);
    const { body } = sendEmail.mock.calls[0][0] as { body: string };
    expect(body).toContain('Opt out here: <a href="https://api.example.test/api/v1/public/unsubscribe?token=');
    expect(body).toContain("Test Street 1, Test City");
  });

  it.each([["OUTBOUND_LEGAL_SENDER_ADDRESS"], ["OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT"]])(
    "flags true but %s missing: LEGAL_CONFIG_MISSING, nothing sent or advanced",
    async (name) => {
      enableAll();
      vi.stubEnv(name, "");
      await processSequenceStep(job);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(enrollmentUpdate).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    },
  );

  it("an unsubscribe text without the {url} placeholder counts as missing", async () => {
    enableAll();
    vi.stubEnv("OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT", "Reply STOP");
    await processSequenceStep(job);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a suppressed recipient is never mailed: enrollment UNSUBSCRIBED + activity logged", async () => {
    enableAll();
    suppressionFindFirst.mockResolvedValue({ id: "sup-1" });
    await processSequenceStep(job);
    expect(suppressionFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", email: "lead@example.test" },
      select: { id: true },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(enrollmentUpdate).toHaveBeenCalledWith({
      where: { id: "enr-1" },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: expect.any(Date) },
    });
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-1", action: "outreach.suppressed_skip" }),
    });
  });

  it("spam guard in the runner: 3 unanswered sends stop the sequence (same result as before)", async () => {
    enableAll();
    activityLogCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    await processSequenceStep(job);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(enrollmentUpdate).toHaveBeenCalledWith({ where: { id: "enr-1" }, data: { status: "COMPLETED" } });
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "outreach.spam_stop", tenantId: "tenant-1" }),
    });
  });

  it("spam guard in the runner: replies offset sends (4 sent - 2 replies = 2 unanswered: still sends)", async () => {
    enableAll();
    activityLogCount.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    await processSequenceStep(job);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});

describe("enroll endpoint: spam guard uses the shared threshold", () => {
  beforeEach(() => { vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true"); });

  it("2 active unanswered enrollments: allowed", async () => {
    enrollmentCount.mockResolvedValue(2);
    const { error, res } = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("a suppressed contact is not enrolled: 409 RECIPIENT_SUPPRESSED + activity_log", async () => {
    contactFindFirst.mockResolvedValue({ id: "contact-1", companyId: "company-1", email: "Lead@Example.test" });
    suppressionFindFirst.mockResolvedValue({ id: "sup-1" });
    const { error } = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(error).toMatchObject({ statusCode: 409, code: "RECIPIENT_SUPPRESSED" });
    expect(suppressionFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", email: "lead@example.test" },
      select: { id: true },
    });
    expect(enrollmentCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        action: "outreach.enroll_blocked_suppressed",
        resourceId: "contact-1",
      }),
    });
  });

  it("a contact that is not suppressed still enrols", async () => {
    contactFindFirst.mockResolvedValue({ id: "contact-1", companyId: "company-1", email: "ok@example.test" });
    suppressionFindFirst.mockResolvedValue(null);
    const { error, res } = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("3 active unanswered enrollments: 429, scoped to the tenant", async () => {
    enrollmentCount.mockResolvedValue(3);
    const { error } = await invoke("/sequences/:id/enroll", { contactId: "contact-1" }, { id: "seq-1" });
    expect(error).toMatchObject({ statusCode: 429 });
    expect(enrollmentCount).toHaveBeenCalledWith({
      where: {
        contactId: "contact-1",
        status: "ACTIVE",
        repliedAt: null,
        sequence: { company: { tenantId: "tenant-1" } },
      },
    });
    expect(enrollmentCreate).not.toHaveBeenCalled();
  });
});
