/** Actual rendering/prefs/batching; the ownership adapter and provider are local stubs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ user: { findMany: vi.fn() }, notificationPref: { findUnique: vi.fn() } }));
const ownership = vi.hoisted(() => ({ currentDevices: vi.fn(), withDelivery: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../lib/db", () => ({ prisma: db }));
vi.mock("../lib/logger", () => ({ logger: log }));
vi.mock("../lib/pushOwnership", () => ({ currentPushDevices: ownership.currentDevices, withCurrentPushDelivery: ownership.withDelivery }));
import { notifyTenantUsers, notifyUser, type NotifyPayload } from "./push";
import type { PushDevice } from "../lib/pushOwnership";
import { NOTIFICATION_LOCALES } from "../lib/notificationLocale";
import { notificationText } from "../lib/notificationCopy";

const fetchStub = vi.fn();
const payload: NotifyPayload = { title: "Legacy title", body: "User/model text <raw> {toolName}", data: { kind: "approval", id: "raw-id" }, badge: 2, localized: { title: "push.agentInputTitle" } };
const device = (id: string, locale: string): PushDevice => ({ id, pushToken: `synthetic-${id}`, locale, userId: "owner-A", pushSessionId: `session-${id}`, pushRevision: 7, pushTokenHash: `hash-${id}` });
let currentDevices: PushDevice[];
let deadFromDeliveries: PushDevice[][];
const messagesAt = (index = 0) => JSON.parse(fetchStub.mock.calls[index][1].body);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue({ json: async () => ({ data: [] }) });
  db.notificationPref.findUnique.mockResolvedValue(null);
  currentDevices = NOTIFICATION_LOCALES.map(locale => device(locale, locale));
  ownership.currentDevices.mockResolvedValue(currentDevices);
  deadFromDeliveries = [];
  ownership.withDelivery.mockImplementation(async (snapshots: PushDevice[], send: (live: PushDevice[]) => Promise<PushDevice[]>) => {
    // Actual authority revalidation and conditional deletion are adapter tests;
    // these tests inspect the exact snapshots dispatch returns for pruning.
    deadFromDeliveries.push(await send(snapshots));
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("per-device push rendering", () => {
  it("localizes all 14 titles on one account while leaving user/model content and routing literal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await notifyUser("owner-A", "approval", payload);
    expect(ownership.currentDevices).toHaveBeenCalledExactlyOnceWith("owner-A");
    expect(ownership.withDelivery).toHaveBeenCalledExactlyOnceWith(currentDevices, expect.any(Function));
    const messages = messagesAt();
    expect(messages).toHaveLength(14);
    for (const [index, locale] of NOTIFICATION_LOCALES.entries()) {
      expect(messages[index]).toEqual({ to: `synthetic-${locale}`, sound: "default", title: notificationText(locale, "push.agentInputTitle"), body: payload.body, data: payload.data, badge: 2, priority: "high", channelId: "approvals" });
    }
    expect(fetchStub).toHaveBeenCalledExactlyOnceWith("https://exp.host/--/api/v2/push/send", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" }, signal: expect.any(AbortSignal) }));
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(deadFromDeliveries).toEqual([[]]);
  });

  it("localizes authored body framing but preserves technical identifiers and English fallback", async () => {
    ownership.currentDevices.mockResolvedValue([device("a", "ar"), device("b", "zh-Hant")]);
    await notifyUser("owner-A", "approval", { ...payload, localized: { title: "push.toolApprovalTitle", body: "push.toolApprovalBody", parameters: { toolName: "technical.raw_tool" } } });
    const messages = messagesAt();
    expect(messages[0].body).toBe(notificationText("ar", "push.toolApprovalBody", { toolName: "technical.raw_tool" }));
    expect(messages[1].title).toBe(notificationText("en", "push.toolApprovalTitle"));
    expect(messages[1].body).toContain("technical.raw_tool");
  });

  it("renders only the devices supplied by the locked ownership recheck", async () => {
    const snapshots = [device("stale", "tr"), device("live", "ar")];
    ownership.currentDevices.mockResolvedValue(snapshots);
    ownership.withDelivery.mockImplementation(async (received, send) => {
      expect(received).toEqual(snapshots);
      deadFromDeliveries.push(await send([snapshots[1]!]));
    });
    await notifyUser("owner-A", "approval", payload);
    expect(messagesAt()).toEqual([expect.objectContaining({ to: "synthetic-live", title: notificationText("ar", "push.agentInputTitle") })]);
    expect(deadFromDeliveries).toEqual([[]]);
  });

  it("does not contact the provider when the ownership adapter finds no live device", async () => {
    ownership.withDelivery.mockResolvedValue(undefined);
    await notifyUser("owner-A", "approval", payload);
    expect(ownership.withDelivery).toHaveBeenCalledOnce();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("retains legacy literal payloads when enabled and omits an absent badge", async () => {
    db.notificationPref.findUnique.mockResolvedValue({ drafts: true });
    await notifyUser("owner-A", "draft", { ...payload, badge: undefined, localized: undefined, data: { kind: "draft" } });
    const message = messagesAt()[0];
    expect(message.title).toBe(payload.title);
    expect(message.body).toBe(payload.body);
    expect(message.channelId).toBe("default");
    expect(message.priority).toBe("default");
    expect(message).not.toHaveProperty("badge");
  });

  it.each(["draft", "run", "company"] as const)("keeps default %s notifications disabled before fetching devices", async kind => {
    await notifyUser("owner-A", kind, { ...payload, data: { kind } });
    expect(ownership.currentDevices).not.toHaveBeenCalled();
    expect(ownership.withDelivery).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("honors explicit opt-outs and company opt-in through runs", async () => {
    db.notificationPref.findUnique.mockResolvedValue({ approvals: false, risks: false, runs: true, drafts: false });
    await notifyUser("owner-A", "approval", payload);
    await notifyUser("owner-A", "risk", { ...payload, data: { kind: "risk" } });
    expect(ownership.currentDevices).not.toHaveBeenCalled();
    await notifyUser("owner-A", "company", { ...payload, data: { kind: "company" } });
    expect(ownership.currentDevices).toHaveBeenCalledExactlyOnceWith("owner-A");
    expect(messagesAt()[0]).toMatchObject({ channelId: "default", priority: "default" });
  });

  it("keeps tenant enumeration, default risks and bounded 100-message delivery calls", async () => {
    db.user.findMany.mockResolvedValue([{ id: "owner-A" }, { id: "owner-B" }]);
    const devices = Array.from({ length: 101 }, (_, i) => device(`id-${i}`, "tr"));
    ownership.currentDevices.mockResolvedValueOnce(devices.slice(0, 100)).mockResolvedValueOnce(devices.slice(100));
    fetchStub.mockResolvedValueOnce({ json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }) });
    await notifyTenantUsers("tenant-A", "risk", { ...payload, data: { kind: "risk" } });
    expect(db.user.findMany).toHaveBeenCalledExactlyOnceWith({ where: { tenantId: "tenant-A" }, select: { id: true } });
    expect(ownership.currentDevices.mock.calls).toEqual([["owner-A"], ["owner-B"]]);
    expect(ownership.withDelivery.mock.calls.map(call => call[0].length)).toEqual([100, 1]);
    expect(fetchStub.mock.calls.map((_call, i) => messagesAt(i).length)).toEqual([100, 1]);
    expect(messagesAt()[0]).toMatchObject({ priority: "high", channelId: "risks", title: notificationText("tr", "push.agentInputTitle") });
    expect(deadFromDeliveries).toEqual([[devices[0]], []]);
    expect(deadFromDeliveries[0]![0]).toBe(devices[0]);
  });

  it("returns exact dead session/revision snapshots indexed against the rechecked live list", async () => {
    const snapshots = [device("stale", "en"), device("first-live", "tr"), device("second-live", "ar")];
    ownership.currentDevices.mockResolvedValue(snapshots);
    ownership.withDelivery.mockImplementation(async (_received, send) => {
      deadFromDeliveries.push(await send([snapshots[2]!, snapshots[1]!]));
    });
    fetchStub.mockResolvedValue({ json: async () => ({ data: [
      { status: "error", details: { error: "DeviceNotRegistered" } },
      { status: "error", details: { error: "MessageTooBig" } },
      { status: "error", details: { error: "DeviceNotRegistered" } },
    ] }) });
    await notifyUser("owner-A", "approval", payload);
    expect(messagesAt().map((message: { to: string }) => message.to)).toEqual(["synthetic-second-live", "synthetic-first-live"]);
    expect(deadFromDeliveries).toEqual([[snapshots[2]]]);
    expect(deadFromDeliveries[0]![0]).toBe(snapshots[2]);
    expect(deadFromDeliveries[0]![0]).toMatchObject({ pushSessionId: "session-second-live", pushRevision: 7, userId: "owner-A" });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deviceId: "first-live" }), "Expo push ticket reported error");
  });

  it("does not prune on top-level provider errors", async () => {
    const errors = [{ code: "SYNTHETIC", message: "Synthetic provider error" }];
    fetchStub.mockResolvedValue({ json: async () => ({ errors, data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }) });
    await notifyUser("owner-A", "approval", payload);
    expect(deadFromDeliveries).toEqual([[]]);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ errors }, "Expo push API returned top-level errors");
  });

  it("treats an unreadable response as having no dead-device evidence", async () => {
    fetchStub.mockResolvedValue({ json: async () => { throw new Error("synthetic invalid JSON"); } });
    await expect(notifyUser("owner-A", "approval", payload)).resolves.toBeUndefined();
    expect(deadFromDeliveries).toEqual([[]]);
  });

  it("skips delivery when no users or no eligible devices exist", async () => {
    db.user.findMany.mockResolvedValue([]);
    await notifyTenantUsers("tenant-A", "approval", payload);
    expect(ownership.currentDevices).not.toHaveBeenCalled();
    ownership.currentDevices.mockResolvedValue([]);
    await notifyUser("owner-A", "approval", payload);
    expect(ownership.withDelivery).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps outbound failures nonfatal without returning false pruning evidence", async () => {
    fetchStub.mockRejectedValue(new Error("synthetic network failure"));
    await expect(notifyUser("owner-A", "approval", payload)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(deadFromDeliveries).toEqual([]);
  });
});
