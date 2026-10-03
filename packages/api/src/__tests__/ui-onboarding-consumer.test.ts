import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = ts.createSourceFile("onboarding.tsx", readFileSync(new URL("../../../ui/app/onboarding/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleLaunch") handler = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!handler) throw new Error("actual onboarding launch closure missing");
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const mounted = { current: true };
  let ownerCurrent = true;
  const bindings = { token: "A-token", mounted, captureAuthSession: () => ({}), isAuthSessionCurrent: () => ownerCurrent,
    companyName: "A", niche: "", targetAudience: "", setLoading: vi.fn(), setError: vi.fn(), setResult: vi.fn(), setStatus: vi.fn(), clearOnboardingDraft: vi.fn(),
    api: { createHeroCompany: vi.fn(() => pending), onboardingStatus: vi.fn().mockResolvedValue({ completed: true }) } };
  const run = new Function(...Object.keys(bindings), `${js}\nreturn handleLaunch;`)(...Object.values(bindings));
  return { ...bindings, run, resolve, reject, changeOwner: () => { ownerCurrent = false; } };
}
it.each(["owner", "unmount"])("late A launch cannot clear B's draft after %s changes", async (boundary) => {
  const h = harness(); const request = h.run();
  if (boundary === "owner") h.changeOwner(); else h.mounted.current = false;
  h.resolve({ company: { id: "A" } }); await request;
  expect(h.clearOnboardingDraft).not.toHaveBeenCalled(); expect(h.setResult).not.toHaveBeenCalled();
  expect(h.api.onboardingStatus).not.toHaveBeenCalled(); expect(h.setLoading).toHaveBeenCalledTimes(1);
});
it("late rejected A launch cannot set B error/loading state", async () => {
  const h = harness(); const request = h.run(); h.changeOwner(); h.reject(new Error("A-only error")); await request;
  expect(h.setError).toHaveBeenCalledTimes(1); expect(h.setError).toHaveBeenCalledWith(null); expect(h.setLoading).toHaveBeenCalledTimes(1);
});
it("current launch completes and clears its own draft", async () => {
  const h = harness(); const request = h.run(); h.resolve({ company: { id: "A" } }); await request;
  expect(h.clearOnboardingDraft).toHaveBeenCalledOnce(); expect(h.setResult).toHaveBeenCalledOnce(); expect(h.setLoading).toHaveBeenLastCalledWith(false);
});
