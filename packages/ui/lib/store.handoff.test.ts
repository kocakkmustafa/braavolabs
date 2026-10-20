import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_HANDOFF_KEY } from "./onboarding-handoff";
import { captureAuthSession, refreshAuthSession, useAppStore } from "./store";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

describe("actual auth store onboarding ownership boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("sessionStorage", storage());
    useAppStore.setState({ token: "synthetic-a", tenantId: "a", refreshToken: "synthetic-refresh", sessionRevision: 10 });
    localStorage.setItem("aicos-onboarding-draft", "private draft");
    sessionStorage.setItem("aicos-build-desc", "private description");
    sessionStorage.setItem(ONBOARDING_HANDOFF_KEY, "private handoff");
  });

  it.each(["setAuth", "clearAuth"] as const)("clears all old-session drafts on %s", action => {
    if (action === "setAuth") useAppStore.getState().setAuth("synthetic-b", "b");
    else useAppStore.getState().clearAuth();
    expect(localStorage.getItem("aicos-onboarding-draft")).toBeNull();
    expect(sessionStorage.getItem("aicos-build-desc")).toBeNull();
    expect(sessionStorage.getItem(ONBOARDING_HANDOFF_KEY)).toBeNull();
    expect(useAppStore.getState().sessionRevision).toBe(11);
  });

  it("retains the same-owner draft on a normal token refresh", () => {
    expect(refreshAuthSession(captureAuthSession(), "synthetic-next", "a", "synthetic-next-refresh")).toBe(true);
    expect(sessionStorage.getItem(ONBOARDING_HANDOFF_KEY)).toBe("private handoff");
    expect(useAppStore.getState().sessionRevision).toBe(10);
  });

  it("clears drafts when refresh reports a tenant boundary change", () => {
    expect(refreshAuthSession(captureAuthSession(), "synthetic-next", "b", "synthetic-next-refresh")).toBe(true);
    expect(sessionStorage.getItem(ONBOARDING_HANDOFF_KEY)).toBeNull();
    expect(localStorage.getItem("aicos-onboarding-draft")).toBeNull();
    expect(useAppStore.getState().sessionRevision).toBe(11);
  });
});
