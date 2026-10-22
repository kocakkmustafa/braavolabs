import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Executes the actual handleLaunch closure from the UI onboarding page with
// synthetic bindings. The launch builds the builder prompt, stores the
// owner-scoped handoff and navigates to /companies/new; it must not let a
// stale owner (A after B signed in) or an unmounted page write the handoff,
// navigate, or change error/loading state.
const source = ts.createSourceFile("onboarding.tsx", readFileSync(new URL("../../../ui/app/onboarding/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleLaunch") handler = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!handler) throw new Error("actual onboarding launch closure missing");
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

type Boundary = "none" | "owner" | "unmount";
function harness(options: { changeDuringPrompt?: Boundary; promptError?: Error; token?: string | null } = {}) {
  const mounted = { current: true };
  let ownerCurrent = true;
  const session = { tenantId: "tenant-A", revision: 1 };
  const change = (boundary: Boundary) => {
    if (boundary === "owner") ownerCurrent = false;
    if (boundary === "unmount") mounted.current = false;
  };
  const bindings = {
    token: options.token === undefined ? "A-token" : options.token, mounted,
    captureAuthSession: vi.fn(() => session),
    isAuthSessionCurrent: vi.fn((captured: unknown) => captured === session && ownerCurrent),
    description: "synthetic description", companyName: "A", niche: "", targetAudience: "",
    selectedIndustry: null, selectedUseCases: [], selectedPrimitives: [],
    onboardingDescription: vi.fn(() => {
      change(options.changeDuringPrompt ?? "none");
      if (options.promptError) throw options.promptError;
      return "synthetic builder prompt";
    }),
    saveOnboardingHandoff: vi.fn(),
    window: { sessionStorage: { marker: "synthetic-session-storage" } },
    router: { push: vi.fn() },
    describeFailure: vi.fn((error: unknown) => `localized:${(error as Error).message}`),
    setLoading: vi.fn(), setError: vi.fn(),
  };
  const run = new Function(...Object.keys(bindings), `${js}\nreturn handleLaunch;`)(...Object.values(bindings));
  return { ...bindings, session, run };
}

it("current launch stores the owner-scoped handoff and opens the builder", async () => {
  const h = harness();
  await h.run();
  expect(h.saveOnboardingHandoff).toHaveBeenCalledExactlyOnceWith(h.window.sessionStorage, h.session, "synthetic builder prompt");
  expect(h.router.push).toHaveBeenCalledExactlyOnceWith("/companies/new");
  expect(h.setError).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.setLoading).toHaveBeenNthCalledWith(1, true);
  expect(h.setLoading).toHaveBeenLastCalledWith(false);
});

it.each(["owner", "unmount"] as const)("stale A launch cannot write the handoff or navigate after %s changes", async (boundary) => {
  const h = harness({ changeDuringPrompt: boundary });
  await h.run();
  expect(h.saveOnboardingHandoff).not.toHaveBeenCalled();
  expect(h.router.push).not.toHaveBeenCalled();
  expect(h.setLoading).toHaveBeenCalledExactlyOnceWith(true);
  expect(h.setError).toHaveBeenCalledExactlyOnceWith(null);
});

it("stale A failure cannot set B error or loading state", async () => {
  const h = harness({ changeDuringPrompt: "owner", promptError: new Error("A-only error") });
  await h.run();
  expect(h.describeFailure).not.toHaveBeenCalled();
  expect(h.setError).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.setLoading).toHaveBeenCalledExactlyOnceWith(true);
  expect(h.router.push).not.toHaveBeenCalled();
});

it("current failure shows the localized error and ends loading", async () => {
  const h = harness({ promptError: new Error("current error") });
  await h.run();
  expect(h.setError).toHaveBeenLastCalledWith("localized:current error");
  expect(h.setLoading).toHaveBeenLastCalledWith(false);
  expect(h.saveOnboardingHandoff).not.toHaveBeenCalled();
  expect(h.router.push).not.toHaveBeenCalled();
});

it("does nothing without a token", async () => {
  const h = harness({ token: null });
  await h.run();
  expect(h.captureAuthSession).not.toHaveBeenCalled();
  expect(h.setLoading).not.toHaveBeenCalled();
  expect(h.saveOnboardingHandoff).not.toHaveBeenCalled();
  expect(h.router.push).not.toHaveBeenCalled();
});
