import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { ZodError } from "zod";

const draftFindUnique = vi.hoisted(() => vi.fn());
const draftUpdate = vi.hoisted(() => vi.fn());
const draftUpdateMany = vi.hoisted(() => vi.fn());
const contactFindFirst = vi.hoisted(() => vi.fn());
const enrollmentFindFirst = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const entitlementFindMany = vi.hoisted(() => vi.fn());
const usageMeterFindUnique = vi.hoisted(() => vi.fn());
const tenantTxMock = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    draft: {
      findUnique: (...args: unknown[]) => draftFindUnique(...args),
      update: (...args: unknown[]) => draftUpdate(...args),
      updateMany: (...args: unknown[]) => draftUpdateMany(...args),
    },
    contact: { findFirst: (...args: unknown[]) => contactFindFirst(...args) },
    outreachEnrollment: { findFirst: (...args: unknown[]) => enrollmentFindFirst(...args) },
    tenant: { findUnique: (...args: unknown[]) => tenantFindUnique(...args) },
    entitlementEvent: { findMany: (...args: unknown[]) => entitlementFindMany(...args) },
    usageMeter: { findUnique: (...args: unknown[]) => usageMeterFindUnique(...args) },
    activityLog: { create: (...args: unknown[]) => activityLogCreate(...args) },
  },
  tenantTx: (...args: unknown[]) => tenantTxMock(...args),
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn() }));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../integrations/email", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import { draftRouter } from "../router";

function handler(method: "post" | "patch") {
  const layer = (draftRouter as Router & { stack: any[] }).stack.find(
    (entry) => entry.route?.path === (method === "post" ? "/:id/approve" : "/:id")
      && entry.route.methods[method],
  );
  if (!layer) throw new Error(`Draft ${method} route missing`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: (error?: any) => void) => Promise<void>;
}

async function invoke(method: "post" | "patch", body: Record<string, unknown>) {
  const res = { json: vi.fn() };
  let error: any;
  await handler(method)(
    { params: { id: "draft-1" }, body, auth: { tenantId: "tenant-1", userId: "user-1" } },
    res,
    (nextError?: any) => { error = nextError; },
  );
  return { res, error };
}

function pendingDraft(companyStatus: string, tenantId = "tenant-1") {
  return {
    id: "draft-1",
    status: "PENDING",
    type: "EMAIL",
    updatedAt: new Date("2026-09-23T00:00:00.000Z"),
    content: { to: "recipient@example.com", subject: "Subject", body: "Body" },
    company: { id: "company-1", tenantId, status: companyStatus },
  };
}

function expectNoDecisionSideEffects() {
  expect(draftUpdate).not.toHaveBeenCalled();
  expect(draftUpdateMany).not.toHaveBeenCalled();
  expect(contactFindFirst).not.toHaveBeenCalled();
  expect(tenantTxMock).not.toHaveBeenCalled();
  expect(sendEmail).not.toHaveBeenCalled();
  expect(activityLogCreate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Existing delivery behavior is asserted with the B-06 gate explicitly
  // enabled; the disabled default has its own suite at the end of this file.
  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
  draftUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "draft-1", ...data }));
  draftUpdateMany.mockResolvedValue({ count: 1 });
  activityLogCreate.mockResolvedValue({});
  contactFindFirst.mockResolvedValue({ id: "contact-1" });
  enrollmentFindFirst.mockResolvedValue(null);
  tenantFindUnique.mockResolvedValue({ plan: "INDIVIDUAL" });
  entitlementFindMany.mockResolvedValue([]);
  usageMeterFindUnique.mockResolvedValue({ value: 200 });
  tenantTxMock.mockResolvedValue([{ value: 1 }]);
  sendEmail.mockResolvedValue({ messageId: "sg-test-accepted" });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("draft decisions respect company lifecycle", () => {
  it.each(["DRAFT", "PAUSED", "ARCHIVED"])(
    "%s company rejects approve-only and send before any side effect",
    async (status) => {
      for (const send of [false, true]) {
        vi.clearAllMocks();
        draftFindUnique.mockResolvedValue(pendingDraft(status));
        const { error } = await invoke("post", { send });
        expect(error).toMatchObject({ statusCode: 409 });
        expectNoDecisionSideEffects();
      }
    },
  );

  it.each(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"])(
    "%s company cannot bypass approval or delivery through PATCH",
    async (companyStatus) => {
      draftFindUnique.mockResolvedValue(pendingDraft(companyStatus));
      for (const status of ["PENDING", "APPROVED", "PUBLISHED"]) {
        const { error } = await invoke("patch", { status });
        expect(error).toBeInstanceOf(ZodError);
        expectNoDecisionSideEffects();
      }
    },
  );

  it("allows an inactive company's content edit and draft archival", async () => {
    draftFindUnique.mockResolvedValueOnce(pendingDraft("ARCHIVED"))
      .mockResolvedValueOnce({ ...pendingDraft("ARCHIVED"), title: "Updated title" });
    const edit = await invoke("patch", { title: "Updated title" });
    expect(edit.error).toBeUndefined();
    expect(edit.res.json).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated title" }));
    expect(draftUpdateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "PENDING", company: { tenantId: "tenant-1" } },
      data: { title: "Updated title" },
    });

    vi.clearAllMocks();
    draftFindUnique.mockResolvedValueOnce(pendingDraft("ARCHIVED"))
      .mockResolvedValueOnce({ ...pendingDraft("ARCHIVED"), status: "ARCHIVED" });
    const archive = await invoke("patch", { status: "ARCHIVED" });
    expect(archive.error).toBeUndefined();
    expect(archive.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "ARCHIVED" }));
    expect(draftUpdateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "PENDING", company: { tenantId: "tenant-1" } },
      data: { status: "ARCHIVED" },
    });
  });

  it.each(["APPROVED", "PUBLISHED", "REJECTED", "ARCHIVED"])(
    "%s draft cannot be edited after its pending decision",
    async (status) => {
      draftFindUnique.mockResolvedValue({ ...pendingDraft("ACTIVE"), status });
      const { error } = await invoke("patch", { content: { body: "changed" } });
      expect(error).toMatchObject({ statusCode: 409 });
      expectNoDecisionSideEffects();
    },
  );

  it("allows rejecting a pending draft, but not rewriting an already published draft as rejected", async () => {
    draftFindUnique.mockResolvedValueOnce(pendingDraft("ACTIVE"))
      .mockResolvedValueOnce({ ...pendingDraft("ACTIVE"), status: "REJECTED" });
    const pending = await invoke("patch", { status: "REJECTED" });
    expect(pending.error).toBeUndefined();
    expect(pending.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
    expect(draftUpdateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "PENDING", company: { tenantId: "tenant-1" } },
      data: { status: "REJECTED" },
    });

    vi.clearAllMocks();
    draftFindUnique.mockResolvedValue({ ...pendingDraft("ACTIVE"), status: "PUBLISHED" });
    const published = await invoke("patch", { status: "REJECTED" });
    expect(published.error).toMatchObject({ statusCode: 409 });
    expectNoDecisionSideEffects();
  });

  it.each(["PUBLISHED", "REJECTED", "ARCHIVED"])(
    "%s draft cannot be silently moved back to PENDING or another terminal state",
    async (currentStatus) => {
      draftFindUnique.mockResolvedValue({ ...pendingDraft("ACTIVE"), status: currentStatus });
      const resurrect = await invoke("patch", { status: "PENDING" });
      expect(resurrect.error).toBeInstanceOf(ZodError);
      expectNoDecisionSideEffects();

      const terminal = await invoke("patch", { status: currentStatus === "REJECTED" ? "ARCHIVED" : "REJECTED" });
      expect(terminal.error).toMatchObject({ statusCode: 409 });
      expectNoDecisionSideEffects();
    },
  );

  it("active company can approve without sending", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    const { error } = await invoke("post", { send: false });
    expect(error).toBeUndefined();
    expect(draftUpdate).toHaveBeenCalledWith({
      where: { id: "draft-1" }, data: { status: "APPROVED" },
    });
    expect(draftUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "draft-1", status: "PENDING",
        updatedAt: new Date("2026-09-23T00:00:00.000Z"),
        content: { equals: { to: "recipient@example.com", subject: "Subject", body: "Body" } },
        company: { tenantId: "tenant-1", status: "ACTIVE" },
      },
      data: { status: "APPROVED" },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("active company can send an allowed email and publish", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    const { error } = await invoke("post", { send: true });
    expect(error).toBeUndefined();
    expect(contactFindFirst).toHaveBeenCalled();
    expect(tenantTxMock).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledWith({
      to: "recipient@example.com", subject: "Subject", body: "Body",
    });
    expect(draftUpdate).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { status: "PUBLISHED", publishedAt: expect.any(Date) },
    });
  });

  it("blocks an opted-out address even when another company has an active contact", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    contactFindFirst.mockResolvedValue({ id: "active-contact" });
    enrollmentFindFirst.mockImplementation(async ({ where }: { where: any }) =>
      where.contact?.email?.mode === "insensitive"
        && where.contact?.company?.tenantId === "tenant-1"
        ? { id: "opt-out-on-second-contact" }
        : null);

    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 403 });
    expect(contactFindFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: "recipient@example.com", mode: "insensitive" },
        company: { tenantId: "tenant-1" },
      },
      select: { id: true },
    });
    expect(draftUpdateMany).not.toHaveBeenCalled();
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not send or spend quota if content changes while the recipient is checked", async () => {
    const readDraft = pendingDraft("ACTIVE");
    let liveContent = readDraft.content;
    draftFindUnique.mockResolvedValue(readDraft);
    contactFindFirst.mockImplementation(async () => {
      liveContent = { ...readDraft.content, body: "Edited during approval" };
      return { id: "contact-1" };
    });
    draftUpdateMany.mockImplementation(async ({ where }: { where: any }) => ({
      count: JSON.stringify(where.content?.equals) === JSON.stringify(liveContent) ? 1 : 0,
    }));

    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 409 });
    expect(draftUpdateMany).toHaveBeenCalledOnce();
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("non-email send cannot claim PUBLISHED without an external delivery", async () => {
    draftFindUnique.mockResolvedValue({ ...pendingDraft("ACTIVE"), type: "SOCIAL_POST" });
    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 422 });
    expectNoDecisionSideEffects();
  });

  it("a competing approve/send request loses the atomic claim before quota or email", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    draftUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    let finishSend!: () => void;
    sendEmail.mockImplementation(() => new Promise((resolve) => {
      finishSend = () => resolve({ messageId: "sg-test-accepted" });
    }));

    const first = invoke("post", { send: true });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    const second = await invoke("post", { send: true });
    expect(second.error).toMatchObject({ statusCode: 409 });
    expect(tenantTxMock).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledOnce();

    finishSend();
    const winner = await first;
    expect(winner.error).toBeUndefined();
    expect(winner.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED" }));
  });

  it("an in-flight send rejects a stale content edit and preserves the sent body", async () => {
    const original = pendingDraft("ACTIVE");
    draftFindUnique.mockResolvedValue(original);
    draftUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    draftUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...original, ...data,
    }));
    let finishSend!: () => void;
    sendEmail.mockImplementation(() => new Promise((resolve) => {
      finishSend = () => resolve({ messageId: "sg-test-accepted" });
    }));

    const sending = invoke("post", { send: true });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    const edit = await invoke("patch", { content: { body: "changed after claim" } });
    expect(edit.error).toMatchObject({ statusCode: 409 });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "recipient@example.com", subject: "Subject", body: "Body",
    });

    finishSend();
    const result = await sending;
    expect(result.error).toBeUndefined();
    expect(result.res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "PUBLISHED", content: original.content,
    }));
  });

  it("ambiguous email failure remains claimed and is logged as uncertain, never published", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    sendEmail.mockRejectedValue(new Error("opaque provider failure"));
    const { error, res } = await invoke("post", { send: true });
    expect(error).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "APPROVED" }));
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "draft.delivery_uncertain" }),
    });
    expect(draftUpdateMany).toHaveBeenCalledTimes(1);
    expect(draftUpdate).toHaveBeenCalledWith({
      where: { id: "draft-1" }, data: { status: "APPROVED" },
    });
  });

  it("offline adapter no-op receipt never becomes a published draft", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    sendEmail.mockResolvedValue({ messageId: "dev_123" });
    const { error, res } = await invoke("post", { send: true });
    expect(error).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "APPROVED" }));
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "draft.delivery_uncertain" }),
    });
  });

  it("quota refusal restores PENDING before any provider attempt", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantTxMock.mockResolvedValue([]);
    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 429 });
    expect(draftUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "draft-1", status: "APPROVED" }, data: { status: "PENDING" },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["INDIVIDUAL", 200],
    ["TEAM", 500],
    ["CREATOR", 200],
    ["PRO", 500],
  ] as const)("%s paid plan uses its paid daily email cap", async (plan, limit) => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantFindUnique.mockResolvedValue({ plan });
    tenantTxMock.mockResolvedValue([]);
    usageMeterFindUnique.mockResolvedValue({ value: limit });

    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 429 });
    expect(error.message).toContain(`(${limit}/${limit})`);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["INDIVIDUAL", "TEAM"])("denies stale %s after ledger expiry before quota INSERT", async (plan) => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantFindUnique.mockResolvedValue({ plan });
    entitlementFindMany.mockResolvedValue([{
      id: "expired-mobile", source: "google", streamId: "mobile",
      sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: plan,
      expiresAt: new Date(Date.now() - 1_000), autoRenew: true,
    }]);

    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 403 });
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(usageMeterFindUnique).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(draftUpdate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
    expect(draftUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "draft-1", status: "APPROVED" }, data: { status: "PENDING" },
    });
    expect(entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
  });

  it("denies a MANUAL_REVIEW ledger even when persisted plan is paid", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    entitlementFindMany.mockResolvedValue([{
      id: "manual-review", source: "google", streamId: "mobile",
      sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "MANUAL_REVIEW",
      expiresAt: new Date(Date.now() + 60_000), autoRenew: true,
    }]);
    expect((await invoke("post", { send: true })).error).toMatchObject({ statusCode: 403 });
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves empty-ledger %s email delivery", async (plan) => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantFindUnique.mockResolvedValue({ plan });
    expect((await invoke("post", { send: true })).error).toBeUndefined();
    expect(entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
    expect(tenantTxMock).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it.each(["FREE", "BUSINESS", "ENTERPRISE", "UNKNOWN"])("denies ambiguous empty-ledger %s before quota INSERT", async (plan) => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantFindUnique.mockResolvedValue({ plan });
    expect((await invoke("post", { send: true })).error).toMatchObject({ statusCode: 403 });
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("keeps the atomic cap and UTC day bucket when a valid Stripe stream overrides expired mobile", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T00:30:00+03:00"));
      draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
      entitlementFindMany.mockResolvedValue([
        { id: "expired", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL", expiresAt: new Date("2026-09-01T00:00:00Z"), autoRenew: true },
        { id: "stripe", source: "stripe", streamId: "stripe", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "TEAM", expiresAt: new Date("2026-11-01T00:00:00Z"), autoRenew: true },
      ]);
      const queryRaw = vi.fn().mockResolvedValue([{ value: 1 }]);
      tenantTxMock.mockImplementation(async (fn) => fn({ $queryRaw: queryRaw }));

      expect((await invoke("post", { send: true })).error).toBeUndefined();
      const [sql, ...values] = queryRaw.mock.calls[0]!;
      expect(sql.join("?")).toContain("ON CONFLICT (tenant_id, metric, period_start) DO UPDATE");
      expect(sql.join("?")).toContain("WHERE usage_meters.value < ?");
      expect(values).toEqual([
        "tenant-1", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"), 500,
      ]);
      expect(sendEmail).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies MANUAL_REVIEW email before creating a fresh quota row", async () => {
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    tenantFindUnique.mockResolvedValue({ plan: "MANUAL_REVIEW" });

    const { error } = await invoke("post", { send: true });
    expect(error).toMatchObject({ statusCode: 403 });
    expect(error.message).toContain("under manual review");
    expect(tenantTxMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["post", "patch"] as const)("%s hides cross-tenant draft before lifecycle checks", async (method) => {
    draftFindUnique.mockResolvedValue(pendingDraft("ARCHIVED", "tenant-2"));
    const { error } = await invoke(method, method === "post" ? { send: true } : { status: "REJECTED" });
    expect(error).toMatchObject({ statusCode: 404 });
    expectNoDecisionSideEffects();
  });
});

describe("B-06: contact email is disabled unless OUTBOUND_EMAIL_ENABLED=true", () => {
  it.each([undefined, "", "false", "1", "TRUE"])(
    "OUTBOUND_EMAIL_ENABLED=%s refuses send with 422 EMAIL_SENDING_DISABLED before any side effect",
    async (value) => {
      if (value === undefined) delete process.env.OUTBOUND_EMAIL_ENABLED;
      else vi.stubEnv("OUTBOUND_EMAIL_ENABLED", value);
      expect(process.env.OUTBOUND_EMAIL_ENABLED).toBe(value);
      draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
      const { error, res } = await invoke("post", { send: true });
      expect(error).toMatchObject({ statusCode: 422, code: "EMAIL_SENDING_DISABLED" });
      expect(res.json).not.toHaveBeenCalled();
      expectNoDecisionSideEffects();
      expect(enrollmentFindFirst).not.toHaveBeenCalled();
    },
  );

  it("still approves without sending while email is disabled", async () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    const { error, res } = await invoke("post", { send: false });
    expect(error).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "APPROVED" }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still edits a pending draft while email is disabled", async () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
    draftFindUnique.mockResolvedValueOnce(pendingDraft("ACTIVE"))
      .mockResolvedValueOnce({ ...pendingDraft("ACTIVE"), title: "Edited" });
    const { error, res } = await invoke("patch", { title: "Edited" });
    expect(error).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ title: "Edited" }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("restores the previous send-and-publish behavior when the flag is \"true\"", async () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    draftFindUnique.mockResolvedValue(pendingDraft("ACTIVE"));
    const { error, res } = await invoke("post", { send: true });
    expect(error).toBeUndefined();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED" }));
  });
});
