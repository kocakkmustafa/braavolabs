import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const source = ts.createSourceFile("login.tsx", readFileSync(new URL("../../../ui/app/login/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submitSource = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSubmit") submitSource = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!submitSource) throw new Error("LoginPage handleSubmit source is missing");
const submitJs = ts.transpileModule(submitSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function harness(mode: "login" | "register") {
  vi.resetModules();
  const storage = new Map<string, string>();
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { localStorage });
  const store = await import("../../../ui/lib/store");
  let resolve!: (data: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  const router = { replace: vi.fn() };
  const mounted = { current: true };
  const bindings = {
    mode, mounted, formOwnsNavigation: { current: false }, email: "synthetic@example.test", password: "Synthetic-Password-1", name: "Synthetic", tenantName: "Synthetic", ref: "",
    validate: () => null, setError: vi.fn(), setLoading: vi.fn(), apiFetch: vi.fn(() => pending),
    setAuth: store.useAppStore.getState().setAuth, router, t: (key: string) => key, authErrorKey: () => "synthetic-error",
    captureAuthSession: store.captureAuthSession, isAuthSessionCurrent: store.isAuthSessionCurrent,
  };
  // Execute the actual consumer closure against the real Zustand store. The
  // API is already resolved at this boundary; its own guard cannot own this commit.
  const submit = new Function(...Object.keys(bindings), `${submitJs}\nreturn handleSubmit;`)(...Object.values(bindings));
  return { ...bindings, store: store.useAppStore, submit, resolve };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const bundle = { token: "A-token", refreshToken: "A-refresh", tenant: { id: "tenant-A" } };

it.each(["login", "register"] as const)("%s cannot commit a resolved A result after B signs in", async (mode) => {
  const h = await harness(mode);
  const request = h.submit({ preventDefault() {} });
  h.store.getState().setAuth("B-token", "tenant-B", "B-refresh");
  h.resolve(bundle);
  await request;
  expect(h.store.getState().token).toBe("B-token");
  expect(h.router.replace).not.toHaveBeenCalled();
});

it.each(["login", "register"] as const)("%s cannot commit after its screen unmounts", async (mode) => {
  const h = await harness(mode);
  const request = h.submit({ preventDefault() {} });
  h.mounted.current = false;
  h.resolve(bundle);
  await request;
  expect(h.store.getState().token).toBeNull();
  expect(h.router.replace).not.toHaveBeenCalled();
});

it.each(["login", "register"] as const)("%s still commits and navigates for its current owner", async (mode) => {
  const h = await harness(mode);
  const request = h.submit({ preventDefault() {} });
  h.resolve(bundle);
  await request;
  expect(h.store.getState().token).toBe("A-token");
  expect(h.router.replace).toHaveBeenCalledWith(mode === "login" ? "/dashboard" : "/onboarding");
});
