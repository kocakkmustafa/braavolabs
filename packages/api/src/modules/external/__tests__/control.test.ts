/**
 * Control-plane capability matrix — pure unit tests (no network, no DB).
 *
 * Pins the HONEST per-platform control surface: we only expose buttons the
 * platform's API can actually back. If someone later claims a capability an
 * adapter doesn't implement (e.g. "stop a running n8n execution"), these fail.
 */
import { describe, it, expect } from "vitest";
import { n8nAdapter } from "../adapters/n8n";
import { makeAdapter } from "../adapters/make";
import { genericAdapter } from "../adapters/generic";

describe("control-plane capabilities (honest matrix)", () => {
  it("n8n: discover + pause/resume, but NO trigger or stop", () => {
    expect(n8nAdapter.capabilities).toEqual({
      discover: true,
      trigger: false,
      pauseResume: true,
      stopExecution: false,
    });
    expect(typeof n8nAdapter.discoverWorkflows).toBe("function");
    expect(typeof n8nAdapter.setActive).toBe("function");
    expect(n8nAdapter.triggerWorkflow).toBeUndefined();
    expect(n8nAdapter.stopExecution).toBeUndefined();
  });

  it("make: discover + trigger + pause/resume, but NO single-execution stop", () => {
    expect(makeAdapter.capabilities).toEqual({
      discover: true,
      trigger: true,
      pauseResume: true,
      stopExecution: false,
    });
    expect(typeof makeAdapter.triggerWorkflow).toBe("function");
    expect(typeof makeAdapter.setActive).toBe("function");
  });

  it("generic / zapier: trigger webhook only (no discover, pause or stop)", () => {
    expect(genericAdapter.capabilities).toEqual({
      discover: false,
      trigger: true,
      pauseResume: false,
      stopExecution: false,
    });
    expect(typeof genericAdapter.triggerWorkflow).toBe("function");
    expect(genericAdapter.discoverWorkflows).toBeUndefined();
    expect(genericAdapter.setActive).toBeUndefined();
  });

  it("every adapter declares a capability for every control verb (no undefined holes)", () => {
    for (const a of [n8nAdapter, makeAdapter, genericAdapter]) {
      for (const k of ["discover", "trigger", "pauseResume", "stopExecution"] as const) {
        expect(typeof a.capabilities[k]).toBe("boolean");
      }
      // A declared capability must have its method, and vice-versa (no lies).
      expect(!!a.capabilities.discover).toBe(typeof a.discoverWorkflows === "function");
      expect(!!a.capabilities.trigger).toBe(typeof a.triggerWorkflow === "function");
      expect(!!a.capabilities.pauseResume).toBe(typeof a.setActive === "function");
      expect(!!a.capabilities.stopExecution).toBe(typeof a.stopExecution === "function");
    }
  });
});
