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
    // The received token must NOT appear — it is caller-controlled and may be
    // the very thing we must not record.
    expect(r.ok === false && r.reason).not.toMatch(/prompt_submitted/);
  });

  it("rejects ANY undeclared property — the default-deny guarantee", () => {
    // This is the case a blocklist misses: a property nobody thought to ban.
    for (const leak of ["prompt", "source_code", "stdout", "url", "note", "q", "x"]) {
      const r = validateProductEvent("landing_view", { [leak]: "anything" });
      expect(r.ok, `property "${leak}" must be rejected`).toBe(false);
      // Reason names the RULE, not the received key (P-6): a computed key could
      // itself carry user text.
      expect(r.ok === false && r.reason).toMatch(/default-deny/);
      expect(r.ok === false && r.reason).not.toContain(leak);
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
    expect(r.ok === false && r.reason).toMatch(/not on its allowed list/);
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


/**
 * Regressions for the findings an independent privacy review PROVED against
 * the first implementation. Each of these passed before the fix.
 */
describe("review regressions", () => {
  it("P-1: prototype-chain EVENT NAMES are not on the allowlist", () => {
    // `PRODUCT_EVENTS[name]` was a bare index, so nine inherited members
    // validated — constructor, toString, __proto__, hasOwnProperty, …
    for (const name of [
      "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
      "propertyIsEnumerable", "toLocaleString", "__proto__", "__defineGetter__",
    ]) {
      const r = validateProductEvent(name as never, {});
      expect(r.ok, `event name "${name}" must be rejected`).toBe(false);
    }
    // control: the real names still work
    expect(validateProductEvent("landing_view", {}).ok).toBe(true);
  });

  it("P-2: the number channel cannot smuggle text", () => {
    // An unbounded 'finite' double carries ~53 bits of caller-chosen mantissa.
    // The review encoded "kaan@x" as 118065990615160 and recovered it from the
    // emitted payload.
    const carrier = 118065990615160;
    expect(validateProductEvent("retained_control_week", { week: carrier }).ok).toBe(false);
    for (const bad of [0.1, Math.PI, 1e308, -1e308, Number.MAX_SAFE_INTEGER, -1, 521]) {
      expect(validateProductEvent("retained_control_week", { week: bad }).ok, `${bad} must be rejected`).toBe(false);
    }
    for (const good of [0, 1, 12, 52, 520]) {
      expect(validateProductEvent("retained_control_week", { week: good }).ok, `${good} must be accepted`).toBe(true);
    }
  });

  it("P-3: a JSON-parsed __proto__ key REJECTS rather than throwing", () => {
    // JSON.parse produces an OWN enumerable "__proto__", unlike a literal — so
    // this is reachable from a real inbound payload. It used to hit
    // `undefined.includes` and throw a TypeError out of a function documented
    // to return a result (which, under Express 4, hangs the request).
    const hostile = JSON.parse('{"__proto__":"SECRET PROMPT TEXT"}');
    let threw = false;
    let result: ReturnType<typeof validateProductEvent> | undefined;
    try { result = validateProductEvent("landing_view", hostile); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  it("P-4: a throwing getter is rejected, not propagated", () => {
    const hostile = Object.defineProperty({}, "surface", {
      enumerable: true,
      get() { throw new Error("boom from getter"); },
    });
    expect(() => validateProductEvent("signup_completed", hostile)).not.toThrow();
    expect(validateProductEvent("signup_completed", hostile).ok).toBe(false);
  });

  it("P-5: the allowlist is frozen against runtime widening", () => {
    expect(Object.isFrozen(PRODUCT_EVENTS)).toBe(true);
    expect(Object.isFrozen(PRODUCT_EVENTS.landing_view.properties)).toBe(true);
    // A privacy control must not be wideable by in-process code.
    expect(() => {
      (PRODUCT_EVENTS as Record<string, unknown>).new_event = { properties: {} };
    }).toThrow();
    expect(validateProductEvent("new_event" as never, {}).ok).toBe(false);
  });

  it("P-6: no rejection reason echoes a caller-supplied token", () => {
    const secret = "SUPER_SECRET_PROMPT_abc123";
    const reasons = [
      validateProductEvent(secret as never, {}),
      validateProductEvent("landing_view", { [secret]: 1 }),
      validateProductEvent("signup_completed", { surface: secret }),
      validateProductEvent("retained_control_week", { week: secret as never }),
    ].map((r) => (r.ok ? "" : r.reason));
    for (const reason of reasons) {
      expect(reason).not.toContain(secret);
    }
  });

  it("rejects -0 so the schema means exactly what it says", () => {
    // -0 passes Number.isInteger and both bounds, and JSON.stringify(-0) is
    // "0" — a bit that exists in memory and vanishes on the wire.
    expect(validateProductEvent("retained_control_week", { week: -0 }).ok).toBe(false);
    expect(validateProductEvent("retained_control_week", { week: 0 }).ok).toBe(true);
  });

  it("Q4: `paid` no longer carries plan (re-identification at low volume)", () => {
    expect(validateProductEvent("paid", { plan: "business" } as never).ok).toBe(false);
    expect(validateProductEvent("paid", {}).ok).toBe(true);
    // conversion-by-tier is still available upstream
    expect(validateProductEvent("checkout_started", { plan: "business" }).ok).toBe(true);
  });
});
