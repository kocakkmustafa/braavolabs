import { beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { compareHarness, deferred, settle } from "./compare-handler-harness";

describe("actual compare form handlers", () => {
  let h: ReturnType<typeof compareHarness>;
  beforeEach(async () => { h = compareHarness(); await h.mount(); h.query(); });
  it("submits exact pairs in edited order with per-model effort and omission", async () => {
    h.add("OPENAI", "gpt-4o"); h.add(); h.effort("high"); h.click("up CEREBRAS / gpt-oss-120b");
    await h.submit(); h.render();
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0][2]).toEqual({companyId: "company-a", query: "Synthetic question for comparison", selections: [
      {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high"}, {provider: "OPENAI", model: "gpt-4o"},
    ]});
    expect(h.view().result.finalAnswer).toBe("synthetic final"); expect(h.text()).toContain("requestedEffort");
  });
  it("provider default removes the field rather than sending null, an empty value or a guessed level", async () => {
    h.add(); h.effort("high"); h.effort(""); await h.submit();
    expect(h.posts()[0][2].selections[0]).not.toHaveProperty("reasoningEffort");
  });
  it("default-only options never expose another provider's effort levels", () => {
    h.add("OPENAI", "gpt-4o");
    const selector = h.find("select", "effort OPENAI / gpt-4o");
    expect(JSON.stringify(selector.props.children)).not.toContain('"high"');
    selector.props.onChange({target: {value: "high"}});
    expect(h.view().selections[0]).not.toHaveProperty("reasoningEffort");
  });
  it("guards duplicate, unavailable and over-limit additions through the actual callback", async () => {
    h.add(); h.add(); h.add("UNKNOWN", "missing"); h.add("OPENAI", "gpt-4o"); h.add("DEEPSEEK", "deepseek-chat");
    const staleAdd = h.find("select", "addModel").props.onChange;
    staleAdd({target: {value: '["CEREBRAS","gpt-oss-120b"]'}});
    expect(h.view().selections).toHaveLength(3);
    h.query("no"); await h.submit(); expect(h.posts()).toHaveLength(0);
    h.query(); await h.submit(); expect(h.posts()[0][2].selections).toHaveLength(3);
  });
  it.each([
    {selections: []}, {selections: [{provider: "UNKNOWN", model: "missing"}]},
    {selections: Array(4).fill({provider: "OPENAI", model: "gpt-4o"})}, {selections: Array(2).fill({provider: "OPENAI", model: "gpt-4o"})},
  ])("submission rechecks invalid choices %j even when invoked directly", async ({selections}) => {
    // Corrupted client state must still never invoke POST; server also validates.
    h.view().selections = selections; await h.submit(); expect(h.posts()).toHaveLength(0); expect(h.view().error).toBe("invalidSelection");
  });
  it.each(["missing endpoint", "malformed metadata"])("fails closed on %s without first-N fallback", async kind => {
    h = compareHarness();
    if (kind === "missing endpoint") { h.pendingOptions = deferred(); h.render(); h.pendingOptions.reject(new Error("HTTP 404")); }
    else { h.options = {companyId: "company-a", models: ["gpt-4o"]}; h.render(); }
    await settle(); h.render(); h.query(); await h.submit();
    expect(h.posts()).toHaveLength(0); expect(h.view().options).toBeUndefined();
  });
  it("keeps explicit effort visible and invalid when refreshed metadata removes support", async () => {
    h.add(); h.effort("high"); h.options.selections[2].reasoningEfforts = [];
    h.click("refresh"); await settle(); h.render();
    expect(h.view().selections[0].reasoningEffort).toBe("high"); expect(h.text()).toContain("unavailable");
    await h.submit(); expect(h.posts()).toHaveLength(0);
    h.effort(""); await h.submit(); expect(h.posts()[0][2].selections[0]).not.toHaveProperty("reasoningEffort");
  });
  it("keeps a removed selected pair invalid until the user explicitly removes it", async () => {
    h.add(); h.options.selections.pop(); h.click("refresh"); await settle(); h.render();
    await h.submit(); expect(h.posts()).toHaveLength(0); expect(h.view().selections).toHaveLength(1);
    h.click("remove CEREBRAS / gpt-oss-120b"); h.add("OPENAI", "gpt-4o"); await h.submit(); expect(h.posts()).toHaveLength(1);
  });
  it("repeated submits before render and during polling share one immutable POST snapshot", async () => {
    h.add(); h.effort("low"); h.pendingStart = deferred();
    const staleQuery = h.find("textarea", "query").props.onChange;
    const first = h.submit(), second = h.submit();
    staleQuery({target: {value: "a different question"}}); h.effort("high"); h.click("remove CEREBRAS / gpt-oss-120b");
    expect(h.posts()).toHaveLength(1); expect(h.posts()[0][2].selections[0].reasoningEffort).toBe("low");
    h.pendingPoll = deferred(); h.pendingStart.resolve(h.start); await settle(); await h.submit(); expect(h.posts()).toHaveLength(1);
    h.pendingPoll.resolve(h.result); await Promise.all([first, second]);
    expect(h.view().query).toBe("Synthetic question for comparison"); expect(h.view().selections[0].reasoningEffort).toBe("low");
  });
  for (const phase of ["options", "post", "poll"] as const) {
    for (const interruption of ["logout", "tenant", "company", "unmount"] as const) {
      it(`${interruption} retires pending ${phase} without late state writes`, async () => {
        const pending = deferred(); let action: Promise<void> | undefined;
        if (phase === "options") { h.pendingOptions = pending; h.click("refresh"); }
        else { h.add(); h[phase === "post" ? "pendingStart" : "pendingPoll"] = pending; action = h.submit(); await settle(); }
        const request = h.calls.filter((c: any[]) => c[0] === phase).at(-1);
        if (interruption === "unmount") h.unmount();
        else {
          if (interruption === "company") { h.companyId = "company-b"; h.options = {...h.options, companyId: "company-b"}; }
          else { h.session.revision++; h.session.tenantId = interruption === "tenant" ? "tenant-b" : null; h.session.token = interruption === "logout" ? null : "synthetic-b"; }
          if (phase === "options") h.pendingOptions = undefined;
          h.render();
        }
        expect(request.at(-1).aborted).toBe(true);
        await settle(); h.writes = [];
        pending.resolve(phase === "options" ? {...h.options, companyId: "company-a"} : phase === "post" ? h.start : h.result);
        await action; await settle(); expect(h.writes).toEqual([]);
      });
    }
  }
  it("a late older metadata request cannot replace newer options or clear its loading state", async () => {
    const old = deferred(); h.pendingOptions = old; h.click("refresh");
    const next = deferred(); h.pendingOptions = next; h.click("refresh");
    old.resolve(h.options); await settle(); expect(h.view().loading).toBe(true); expect(h.view().options).toBeUndefined();
    next.resolve(h.options); await settle(); expect(h.view().loading).toBe(false); expect(h.view().options).toEqual(h.options);
  });
  it("owner retirement before rerender still suppresses a pending response and further polling", async () => {
    h.add(); h.pendingStart = deferred(); const action = h.submit(); h.session.revision++; h.session.token = null; h.writes = [];
    h.pendingStart.resolve(h.start); await action; expect(h.writes).toEqual([]); expect(h.polls()).toHaveLength(0);
  });
  it("old finally cannot release a newer company's pending submission", async () => {
    h.add(); const old = deferred(); h.pendingStart = old; const first = h.submit();
    h.companyId = "company-b"; h.options = {...h.options, companyId: "company-b"}; h.pendingStart = deferred();
    h.render(); await settle(); h.render(); h.query(); h.add(); const second = h.submit();
    old.resolve(h.start); await first; expect(h.view().busy).toBe(true); await h.submit(); expect(h.posts()).toHaveLength(2);
    h.pendingStart.reject(new Error("synthetic rejection")); await second; expect(h.view().busy).toBe(false);
  });
  it("same-owner token refresh preserves choices and uses the current token for the next poll", async () => {
    h.add(); h.effort("medium"); h.pendingStart = deferred(); const action = h.submit();
    h.session.token = "synthetic-refreshed"; h.render(); h.pendingStart.resolve(h.start); await action;
    expect(h.polls()[0][1]).toBe("synthetic-refreshed"); expect(h.view().selections[0].reasoningEffort).toBe("medium");
    expect(h.calls.filter((c: any[]) => c[0] === "options")).toHaveLength(1);
  });
  it("unmount cancels the scheduled poll and stops subsequent reads without another POST", async () => {
    h.add(); h.result = {...h.result, status: "RUNNING"}; const action = h.submit(); await settle();
    expect(h.timers.size).toBe(1); h.unmount(); expect(h.timers.size).toBe(0); await action;
    expect(h.polls()).toHaveLength(1); expect(h.posts()).toHaveLength(1);
  });
  it.each(["FAILED", "CANCELLED"])("reports terminal %s explicitly with no result and no retry", async status => {
    h.add(); h.result = {...h.result, status}; await h.submit();
    expect(h.view().result).toBeUndefined(); expect(h.view().error).toBe(status === "FAILED" ? "failed" : "cancelled");
    expect(h.posts()).toHaveLength(1); expect(h.view().busy).toBe(false);
  });
  it("poll transport failure is visible and never repeats the start request", async () => {
    h.add(); h.pendingPoll = deferred(); const action = h.submit(); await settle(); h.pendingPoll.reject(new Error("synthetic poll failure")); await action;
    expect(h.view().error).toBe("synthetic poll failure"); expect(h.posts()).toHaveLength(1); expect(h.view().result).toBeUndefined();
  });
  it("a bounded polling timeout clears the latch without claiming the server work stopped", async () => {
    h.add(); h.result = {...h.result, status: "RUNNING"}; const action = h.submit(); await settle();
    for (let i = 0; i < 149; i++) await h.fireTimers(); await action;
    expect(h.polls()).toHaveLength(150); expect(h.timers.size).toBe(0); expect(h.view().error).toBe("timeout"); expect(h.posts()).toHaveLength(1);
  });
  it("rejects a cross-company poll response before publishing an answer", async () => {
    h.add(); h.result.companyId = "company-b"; await h.submit();
    expect(h.view().result).toBeUndefined(); expect(h.view().error).toBe("Invalid compare session response");
  });
  it("renders partial candidate failures and synthesis failure explicitly", async () => {
    h.add(); h.result.findings.multiModel.failed = [{provider: "OPENAI", model: "gpt-4o", error: "synthetic candidate failure"}];
    h.result.findings.multiModel.synthesisStatus = "unavailable"; h.result.findings.multiModel.synthesizerError = "synthetic synthesis failure";
    await h.submit(); h.render(); expect(h.text()).toContain("synthetic candidate failure"); expect(h.text()).toContain("synthetic synthesis failure");
  });
});

describe("actual company page load retirement", () => {
  it("a late company load cannot overwrite the current company", async () => {
    const h = compareHarness(resolve(process.cwd(), "app/companies/[id]/page.tsx"));
    const first = deferred(); h.pendingCompany = first; h.render();
    h.companyId = "company-b"; h.pendingCompany = deferred(); h.render();
    h.pendingCompany.resolve({id: "company-b", name: "Synthetic B", agents: [], pipelines: []}); await settle(); h.render();
    h.writes = []; first.resolve({id: "company-a", name: "Synthetic A", agents: [], pipelines: []}); await settle();
    expect(h.writes).toEqual([]); expect(h.text()).toContain("Synthetic B"); expect(h.text()).not.toContain("Synthetic A");
  });
  it("a late company error after logout cannot publish feedback", async () => {
    const h = compareHarness(resolve(process.cwd(), "app/companies/[id]/page.tsx")); h.pendingCompany = deferred(); h.render();
    h.session.revision++; h.session.token = null; h.writes = [];
    h.pendingCompany.reject(new Error("old company error")); await settle(); expect(h.writes).toEqual([]);
  });
});


describe("loaded company owner scope before effects", () => {
  const page = () => compareHarness(resolve(process.cwd(), "app/companies/[id]/page.tsx"));
  it.each(["new tenant", "new login in same tenant"])("hides an already loaded company synchronously for %s on the same route", async kind => {
    const h = page(); await h.mount(); expect(h.text()).toContain("Synthetic");
    h.session.revision++; h.session.token = "synthetic-owner-b";
    if (kind === "new tenant") h.session.tenantId = "tenant-b";
    h.pendingCompany = deferred(); h.writes = []; h.render(false);
    expect(h.writes).toEqual([]); // Retirement must happen in render, without an effect/state clear.
    expect(h.text()).not.toContain("Synthetic"); expect(h.text()).not.toContain("company-a");
    expect(h.text()).toContain("animate-shimmer");
    h.flushEffects(); h.pendingCompany.resolve({id: "company-a", name: "Current owner B", status: "ACTIVE", agents: [], pipelines: []});
    await settle(); h.render(); expect(h.text()).toContain("Current owner B");
  });
  it.each(["owner", "company"])("hides a loaded error synchronously after a %s change", async kind => {
    const h = page(); h.pendingCompany = deferred(); h.render(); h.pendingCompany.reject(new Error("Synthetic owner A error"));
    await settle(); h.render(); expect(h.text()).toContain("Synthetic owner A error");
    if (kind === "owner") { h.session.revision++; h.session.tenantId = "tenant-b"; h.session.token = "synthetic-b"; }
    else h.companyId = "company-b";
    h.pendingCompany = deferred(); h.writes = []; h.render(false);
    expect(h.writes).toEqual([]); expect(h.text()).not.toContain("Synthetic owner A error"); expect(h.text()).toContain("animate-shimmer");
    h.flushEffects(); h.pendingCompany.resolve({id: h.companyId, name: "Current company", status: "ACTIVE", agents: [], pipelines: []});
    await settle(); h.render(); expect(h.text()).toContain("Current company");
  });
  it("same-owner token rotation preserves loaded company data and performs no new load", async () => {
    const h = page(); await h.mount(); const before = h.text(); const calls = h.calls.length;
    h.session.token = "synthetic-refreshed"; h.writes = []; h.render(false);
    expect(h.text()).toBe(before); expect(h.writes).toEqual([]); h.flushEffects(); expect(h.calls.length).toBe(calls);
  });
  it("same-owner token rotation preserves an existing load error", async () => {
    const h = page(); h.pendingCompany = deferred(); h.render(); h.pendingCompany.reject(new Error("Current owner error"));
    await settle(); h.render(); const calls = h.calls.length;
    h.session.token = "synthetic-refreshed"; h.writes = []; h.render(false);
    expect(h.text()).toContain("Current owner error"); expect(h.writes).toEqual([]); h.flushEffects(); expect(h.calls.length).toBe(calls);
  });
});
