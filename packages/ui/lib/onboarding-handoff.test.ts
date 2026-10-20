import { describe, it, expect } from "vitest";
import { onboardingDescription, saveOnboardingHandoff, consumeOnboardingHandoff, ONBOARDING_HANDOFF_KEY } from "./onboarding-handoff";

const owner = { tenantId: "tenant-A", revision: 4 };
function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}
describe("actual onboarding-to-builder handoff", () => {
  it("retains every selected input instead of substituting the social-media template", () => {
    const text = onboardingDescription({ description: "Audit inventory", companyName: "Ops", niche: "parts", targetAudience: "factories", selectedIndustry: "operations", selectedUseCases: ["Track stock", "Report costs"], selectedPrimitives: ["operations", "finance"] });
    for (const expected of ["Audit inventory", "Ops", "parts", "factories", "operations", "Track stock", "Report costs", "finance"]) expect(text).toContain(expected);
    expect(text).not.toContain("social media");
    const store = memory(); saveOnboardingHandoff(store, owner, text, 100);
    expect(consumeOnboardingHandoff(store, owner, 200)).toBe(text);
    expect(consumeOnboardingHandoff(store, owner, 200)).toBeNull();
  });
  it.each([{ tenantId: "tenant-B", revision: 4 }, { tenantId: "tenant-A", revision: 5 }])("drops a superseded owner %j", next => {
    const store = memory(); saveOnboardingHandoff(store, owner, "private draft", 100);
    expect(consumeOnboardingHandoff(store, next, 200)).toBeNull();
    expect(store.getItem(ONBOARDING_HANDOFF_KEY)).toBeNull();
  });
  it.each([0, 15 * 60_000 + 101])("drops future-dated/expired handoffs at %d", now => {
    const store = memory(); saveOnboardingHandoff(store, owner, "private draft", 100);
    expect(consumeOnboardingHandoff(store, owner, now)).toBeNull();
  });
  it("removes malformed storage and reports a storage failure without pretending navigation succeeded", () => {
    const store = memory(); store.setItem(ONBOARDING_HANDOFF_KEY, "{");
    expect(consumeOnboardingHandoff(store, owner)).toBeNull();
    expect(() => saveOnboardingHandoff({ ...store, setItem: () => { throw new Error("quota"); } }, owner, "valid draft")).toThrow("quota");
  });
  it("persists only the draft owner identifiers even when given an auth-session object", () => {
    const store = memory();
    const session = { ...owner, token: "synthetic-access", refreshToken: "synthetic-refresh" };
    saveOnboardingHandoff(store, session, "draft", 100);
    const raw = store.getItem(ONBOARDING_HANDOFF_KEY)!;
    expect(JSON.parse(raw)).toEqual({ ...owner, description: "draft", createdAt: 100 });
    expect(raw).not.toContain(session.token); expect(raw).not.toContain(session.refreshToken);
  });
});
