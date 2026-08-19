import { describe, it, expect } from "vitest";
import {
  PRODUCT_EVENTS,
  validateProductEvent,
  ProductEventRejected,
} from "../product-events";

/**
 * BR-P1-004 — product analytics allowlist (roadmap §6.5).
 *
 * The privacy commitment is specific: "Prompt, source code, terminal output,
 * raw URL ve free text toplanmaz." Enforcing that with a BLOCKLIST (reject
 * anything containing "prompt") is defeatable by the next property somebody
 * adds. So the rule here is default-deny on PROPERTY NAMES: an event may carry
 * only the properties its schema declares, with the types it declares.
 *
 * That inversion is the whole point — a new field cannot leak by default,
 * because a field nobody allowed is rejected.
 */
describe("the allowlist itself", () => {
  it("is exactly the roadmap §6.5 event set — no more, no less", () => {
    expect(Object.keys(PRODUCT_EVENTS).sort()).toEqual([
      "approval_decided", "approval_viewed", "checkout_started", "cli_installed",
      "desktop_installed", "device_paired", "first_run_started", "first_run_succeeded",
      "landing_view", "paid", "provider_connected", "retained_control_week",
      "run_steered", "signup_completed",
    ]);
  });
});

describe("validateProductEvent — accepts what it should", () => {
  it("accepts a declared event with no properties", () => {
    expect(validateProductEvent("landing_view", {}).ok).toBe(true);
  });

  it("accepts declared properties with declared types", () => {
    const r = validateProductEvent("approval_decided", { decision: "approved", surface: "mobile" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.event.properties).toEqual({ decision: "approved", surface: "mobile" });
  });
});

describe("validateProductEvent — refuses what it must", () => {
  it("rejects an event name that is not on the allowlist", () => {
    const r = validateProductEvent("prompt_submitted" as never, {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not on the product-event allowlist/);
  });

  it("rejects ANY undeclared property — the default-deny guarantee", () => {
    // This is the case a blocklist misses: a property nobody thought to ban.
    for (const leak of ["prompt", "source_code", "stdout", "url", "note", "q", "x"]) {
      const r = validateProductEvent("landing_view", { [leak]: "anything" });
      expect(r.ok, `property "${leak}" must be rejected`).toBe(false);
      expect(r.ok === false && r.reason).toMatch(new RegExp(`"${leak}"`));
    }
  });

  it("rejects a declared property carrying the WRONG type", () => {
    const r = validateProductEvent("approval_decided", { decision: { nested: "object" } as never });
    expect(r.ok).toBe(false);
  });

  it("rejects a value outside a declared enum, even on an allowed property", () => {
    // `decision` is allowed, but only as one of a fixed set. Free text on an
    // allowed key is exactly how a prompt would slip through.
    const r = validateProductEvent("approval_decided", { decision: "the user said: rm -rf /" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not an allowed value/);
  });

  it("never lets a raw URL through, on any event", () => {
    for (const ev of Object.keys(PRODUCT_EVENTS)) {
      const r = validateProductEvent(ev as never, { url: "https://app.example/secret?token=abc" });
      expect(r.ok, `${ev} must not accept a url property`).toBe(false);
    }
  });

  it("throws a typed error from the strict helper, for callers that prefer it", () => {
    expect(() => ProductEventRejected.assert(validateProductEvent("landing_view", { prompt: "hi" })))
      .toThrow(ProductEventRejected);
  });
});

describe("the emitted event carries no identifying free text", () => {
  it("keeps only allowlisted properties in the emitted payload", () => {
    const r = validateProductEvent("first_run_succeeded", { surface: "desktop", duration_bucket: "under_10m" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Serialised, the payload must contain nothing beyond name + declared props.
      const keys = Object.keys(r.event.properties);
      expect(keys.every((k) => k in PRODUCT_EVENTS.first_run_succeeded.properties)).toBe(true);
    }
  });
});
