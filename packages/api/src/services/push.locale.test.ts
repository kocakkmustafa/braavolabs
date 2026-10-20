/** Actual dispatch and prefs selection. fetch/Prisma are local stubs; never sends a push. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ user: { findMany: vi.fn() }, notificationPref: { findUnique: vi.fn() }, device: { findMany: vi.fn(), deleteMany: vi.fn() } }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../lib/db", () => ({ prisma: db }));
vi.mock("../lib/logger", () => ({ logger: log }));
import { notifyTenantUsers, notifyUser, type NotifyPayload } from "./push";
import { NOTIFICATION_LOCALES } from "../lib/notificationLocale";
import { notificationText } from "../lib/notificationCopy";
const fetchStub = vi.fn();
const payload: NotifyPayload = { title: "Legacy title", body: "User/model text <raw> {toolName}", data: { kind: "approval", id: "raw-id" }, badge: 2, localized: { title: "push.agentInputTitle" } };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue({ json: async () => ({ data: [] }) });
  db.notificationPref.findUnique.mockResolvedValue(null);
  db.device.findMany.mockResolvedValue(NOTIFICATION_LOCALES.map(locale => ({ id: `device-${locale}`, pushToken: `synthetic-${locale}`, locale })));
  db.device.deleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllGlobals());
describe("per-device push rendering", () => {
  it("localizes all 14 titles on the same account while leaving user/model content and routing literal", async () => {
    await notifyUser("owner-A", "approval", payload);
    expect(db.device.findMany).toHaveBeenCalledWith({ where: { userId: "owner-A" }, select: { id: true, pushToken: true, locale: true } });
    const messages = JSON.parse(fetchStub.mock.calls[0][1].body);
    expect(messages).toHaveLength(14);
    for (const [index, locale] of NOTIFICATION_LOCALES.entries()) {
      expect(messages[index]).toEqual({ to: `synthetic-${locale}`, sound: "default", title: notificationText(locale, "push.agentInputTitle"), body: payload.body, data: payload.data, badge: 2, priority: "high", channelId: "approvals" });
    }
    expect(fetchStub.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("localizes authored body framing but preserves technical tool identifiers and English fallback", async () => {
    db.device.findMany.mockResolvedValue([{ id: "a", pushToken: "a", locale: "ar" }, { id: "b", pushToken: "b", locale: "zh-Hant" }]);
    await notifyUser("owner-A", "approval", { ...payload, localized: { title: "push.toolApprovalTitle", body: "push.toolApprovalBody", parameters: { toolName: "technical.raw_tool" } } });
    const messages = JSON.parse(fetchStub.mock.calls[0][1].body);
    expect(messages[0].body).toBe(notificationText("ar", "push.toolApprovalBody", { toolName: "technical.raw_tool" }));
    expect(messages[1].title).toBe(notificationText("en", "push.toolApprovalTitle"));
    expect(messages[1].body).toContain("technical.raw_tool");
  });
  it("retains legacy literal payloads and existing opt-in defaults", async () => {
    await notifyUser("owner-A", "draft", { ...payload, localized: undefined });
    expect(fetchStub).not.toHaveBeenCalled(); expect(db.device.findMany).not.toHaveBeenCalled();
    db.notificationPref.findUnique.mockResolvedValue({ drafts: true });
    await notifyUser("owner-A", "draft", { ...payload, localized: undefined, data: { kind: "draft" } });
    const message = JSON.parse(fetchStub.mock.calls[0][1].body)[0];
    expect(message.title).toBe(payload.title); expect(message.body).toBe(payload.body);
    expect(message.channelId).toBe("default"); expect(message.priority).toBe("default");
  });
  it("keeps tenant enumeration, 100-message batches and dead-token pruning intact", async () => {
    db.user.findMany.mockResolvedValue([{ id: "owner-A" }]);
    db.device.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, pushToken: `token-${i}`, locale: "tr" })));
    fetchStub.mockResolvedValueOnce({ json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }) }).mockResolvedValueOnce({ json: async () => ({ data: [] }) });
    await notifyTenantUsers("tenant-A", "risk", { ...payload, data: { kind: "risk" } });
    expect(db.user.findMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-A" }, select: { id: true } });
    expect(fetchStub.mock.calls.map(call => JSON.parse(call[1].body).length)).toEqual([100, 1]);
    expect(db.device.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["id-0"] } } });
  });
  it("keeps outbound failures nonfatal", async () => {
    fetchStub.mockRejectedValue(new Error("synthetic network failure"));
    await expect(notifyUser("owner-A", "approval", payload)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
