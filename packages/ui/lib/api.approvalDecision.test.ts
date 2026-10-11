import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./store", () => ({ captureAuthSession: () => ({ revision: 1, tenantId: "synthetic-tenant", token: "synthetic-token" }), isAuthSessionCurrent: () => true, useAppStore: { getState: () => ({ token: "synthetic-token" }) } }));
import { api } from "./api";
const fetchSpy = vi.fn();
beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });
const response = (result: unknown) => ({ ok: true, status: 200, json: async () => result });
describe("actual approval API response", () => {
  it.each(["APPROVED", "REJECTED"] as const)("consumes committed %s outcome and preserves the INPUT note contract", async decision => {
    fetchSpy.mockResolvedValue(response({ success: true, decision }));
    await expect(api.decideApproval("synthetic-token", "synthetic-id", decision, "INPUT answer")).resolves.toEqual({ success: true, decision });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("/approvals/synthetic-id/decide"); expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ decision, note: "INPUT answer" });
  });
  it("retains the committed decision and handoff failure without another request", async () => {
    const result = { success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" };
    fetchSpy.mockResolvedValue(response(result));
    await expect(api.decideApproval("synthetic-token", "synthetic-id", "APPROVED")).resolves.toEqual(result);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("rejects a malformed 200 success without replaying", async () => {
    fetchSpy.mockResolvedValue(response({ success: true, decision: "APPROVED", claimFailed: "true" }));
    await expect(api.decideApproval("synthetic-token", "synthetic-id", "APPROVED")).rejects.toThrow("Invalid approval decision response");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
