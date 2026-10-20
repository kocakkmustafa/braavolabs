import { beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { screenHarness } from "./approval-handler-harness";

const targets = [["web approvals", "app/approvals/page.tsx", "web", "queue"]] as const;
for (const [name, relative, surface, screen] of targets) {
  describe(name + " actual source decision handler", () => {
    let h: ReturnType<typeof screenHarness>;
    beforeEach(async () => { h = screenHarness(resolve(process.cwd(), relative), surface, screen); await h.mount(); });
    it("removes the committed approval but reports handoff failure without success feedback or retry", async () => {
      h.response = { success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" };
      await h.decide();
      expect(h.rows()).toHaveLength(0); expect(h.postCount()).toBe(1);
      expect(h.feedback).not.toContain("success"); expect(h.feedback).toContain("error");
      expect(h.text()).toContain("handoff"); expect(h.text()).toContain("not frozen");
    });
    it.each(["APPROVED", "REJECTED"])("retains ordinary %s behavior", async decision => {
      h.response = { success: true, decision }; await h.decide(decision);
      expect(h.rows()).toHaveLength(0); expect(h.postCount()).toBe(1); expect(h.text()).not.toContain("handoff");
    });
    it("a second in-flight action and a repeated committed action never re-POST", async () => {
      let finish!: (x: unknown) => void; h.pending = new Promise(resolve => { finish = resolve; });
      const first = h.decide(); const second = h.decide();
      expect(h.postCount()).toBe(1);
      finish({ success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" });
      await Promise.all([first, second]); await h.decide(); expect(h.postCount()).toBe(1);
    });
    it.each(["unmounted", "new session"])("late result from %s cannot mutate state or give feedback", async scenario => {
      let finish!: (x: unknown) => void; h.pending = new Promise(resolve => { finish = resolve; });
      const action = h.decide();
      if (scenario === "unmounted") h.unmount(); else { h.session.revision++; h.session.generation++; }
      h.calls = []; h.feedback = []; h.alerts = [];
      finish({ success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" }); await action;
      expect(h.calls).toEqual([]); expect(h.feedback).toEqual([]); expect(h.alerts).toEqual([]);
    });
    it("validation failure keeps pending row, reports failure, and does not retry automatically", async () => {
      h.reject = new Error("Validation error"); await h.decide();
      expect(h.rows()).toHaveLength(1); expect(h.postCount()).toBe(1);
      expect(h.feedback).not.toContain("success"); expect(h.text()).toContain("generic"); expect(h.text()).not.toContain("Validation error");
    });
    it("malformed successful outcome is never treated as success", async () => {
      h.response = { success: true, decision: "APPROVED", claimFailed: "true" }; await h.decide();
      expect(h.rows()).toHaveLength(1); expect(h.feedback).not.toContain("success"); expect(h.postCount()).toBe(1);
    });
  });
}
