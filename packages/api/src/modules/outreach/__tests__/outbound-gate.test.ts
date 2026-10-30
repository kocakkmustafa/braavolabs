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
vi.mock("../../../config/env", () => ({ env: { REDIS_URL: "redis://127.0.0.1:1" } }));
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

  it("restores the previous step processing when both flags are \"true\"", async () => {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    await processSequenceStep(job);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "lead@example.test",
      subject: "Hello",
      body: "Hi Lead",
    }));
    expect(enrollmentUpdate).toHaveBeenCalledWith({ where: { id: "enr-1" }, data: { currentStep: 1 } });
  });
});
