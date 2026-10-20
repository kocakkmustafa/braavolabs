/** Actual Express handlers with synthetic auth/DB. No listener or database connection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ device: { upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() } }));
const auth = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db", () => ({ prisma: db }));
vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn() } }));
vi.mock("../../middleware/auth", () => ({ authMiddleware: auth }));
import { deviceRouter } from "./router";

async function invoke(method: string, path: string, body: unknown, userId = "owner-A", header = "en") {
  const layer = (deviceRouter as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  const json = vi.fn(); const next = vi.fn();
  await layer.route.stack.at(-1).handle({ body, headers: { "accept-language": header }, auth: { userId } }, { json }, next);
  return { json, next };
}
beforeEach(() => { vi.clearAllMocks(); db.device.updateMany.mockResolvedValue({ count: 1 }); db.device.deleteMany.mockResolvedValue({ count: 1 }); });
describe("per-device language ownership", () => {
  it("keeps authentication before all device handlers", () => {
    expect((deviceRouter as any).stack[0].handle).toBe(auth);
  });
  it("initializes both new and transferred tokens from the incoming account's explicit choice", async () => {
    const { next } = await invoke("post", "/push-token", { token: "synthetic-token", platform: "ios", locale: "ar" }, "owner-B", "tr");
    expect(next).not.toHaveBeenCalled();
    expect(db.device.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { pushToken: "synthetic-token" },
      create: expect.objectContaining({ userId: "owner-B", locale: "ar" }),
      update: expect.objectContaining({ userId: "owner-B", locale: "ar" }),
    }));
  });
  it("uses the selected app header for existing clients and safe English when absent", async () => {
    await invoke("post", "/push-token", { token: "synthetic-token", platform: "android" }, "owner-A", "pt-PT");
    expect(db.device.upsert.mock.calls[0][0].create.locale).toBe("pt-BR");
    await invoke("post", "/push-token", { token: "synthetic-token", platform: "android" }, "owner-B", "zh-Hant");
    expect(db.device.upsert.mock.calls[1][0].update.locale).toBe("en");
  });
  it("updates locale under one atomic token-and-current-user predicate", async () => {
    const { json, next } = await invoke("patch", "/push-token/locale", { token: "synthetic-token", locale: "ja" }, "owner-B");
    expect(next).not.toHaveBeenCalled();
    expect(db.device.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { pushToken: "synthetic-token", userId: "owner-B" }, data: { locale: "ja" } });
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(db.device.upsert).not.toHaveBeenCalled();
  });
  it("does not report a foreign or unregistered token as an applied preference", async () => {
    db.device.updateMany.mockResolvedValue({ count: 0 });
    const { json } = await invoke("patch", "/push-token/locale", { token: "synthetic-token", locale: "tr" });
    expect(json).toHaveBeenCalledWith({ success: false });
  });
  it.each([0, 1])("unregisters under one atomic ownership predicate and keeps the same response for count %s", async count => {
    db.device.deleteMany.mockResolvedValue({ count });
    const { json, next } = await invoke("delete", "/push-token", { token: "synthetic-token" }, "retired-owner-A");
    expect(next).not.toHaveBeenCalled();
    expect(db.device.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { pushToken: "synthetic-token", userId: "retired-owner-A" } });
    expect(json).toHaveBeenCalledWith({ success: true });
  });
  it.each(["zh-Hant", "en-Cyrl", "ar-SA", "<script>"])("rejects noncanonical explicit metadata %s before DB mutation", async locale => {
    const { next } = await invoke("patch", "/push-token/locale", { token: "synthetic-token", locale });
    expect(next).toHaveBeenCalledOnce(); expect(db.device.updateMany).not.toHaveBeenCalled();
  });
});
