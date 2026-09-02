/**
 * Product analytics allowlist (BR-P1-004, roadmap §6.5).
 *
 * The privacy commitment is specific: "Prompt, source code, terminal output,
 * raw URL ve free text toplanmaz."
 *
 * Enforced by DEFAULT-DENY ON PROPERTY NAMES, not by a blocklist. A blocklist
 * ("reject anything called prompt") is defeated by the next field somebody
 * adds — `note`, `q`, `context`, `detail`. Here an event may carry ONLY the
 * properties its schema declares, so a field nobody authorised cannot leak
 * even by accident.
 *
 * The second half matters just as much: allowed properties are ENUMS or
 * numbers, never open strings. Free text arriving on a permitted key
 * (`decision: "the user said: …"`) is exactly how a prompt slips past a
 * name-only check.
 */

import { logger } from "./logger";

/** A property may be a fixed set of strings, or a number. Never free text. */
type PropSpec =
  | { enum: readonly string[] }
  // Bounded and integral, ALWAYS. An unbounded "finite number" is a covert
  // channel: an IEEE-754 double carries ~53 bits of caller-chosen mantissa,
  // which is ~6 ASCII characters or a stable pseudonymous id smuggled through
  // a field named "week". Proven by review, not hypothesised.
  | { integer: true; min: number; max: number };

interface EventSpec {
  readonly properties: Readonly<Record<string, PropSpec>>;
}

const SURFACE = { enum: ["web", "desktop", "cli", "mobile"] } as const;
/** Bucketed, never a raw duration — a precise ms value is a weak identifier. */
const DURATION_BUCKET = {
  enum: ["under_1m", "under_10m", "under_30m", "over_30m"],
} as const;

export const PRODUCT_EVENTS = {
  landing_view: { properties: {} },
  signup_completed: { properties: { surface: SURFACE } },
  desktop_installed: { properties: { os: { enum: ["macos", "windows", "linux"] } } },
  cli_installed: { properties: { os: { enum: ["macos", "windows", "linux"] } } },
  provider_connected: {
    properties: { kind: { enum: ["byok", "local", "trial"] } },
  },
  first_run_started: { properties: { surface: SURFACE } },
  first_run_succeeded: { properties: { surface: SURFACE, duration_bucket: DURATION_BUCKET } },
  device_paired: { properties: { surface: SURFACE } },
  approval_viewed: { properties: { surface: SURFACE } },
  approval_decided: {
    properties: { surface: SURFACE, decision: { enum: ["approved", "denied"] } },
  },
  run_steered: { properties: { surface: SURFACE } },
  checkout_started: { properties: { plan: { enum: ["creator", "pro", "business"] } } },
  // `plan` deliberately OMITTED here. checkout_started already gives conversion
  // by tier, and at this product's actual volume `paid{plan:"business"}` is
  // plausibly a population of one — which becomes re-identification the moment
  // a resettable install id makes the funnel joinable per person.
  paid: { properties: {} },
  // Weeks since activation. Bounded to ten years: the value is a small ordinal,
  // and anything wider is a payload channel rather than a week number.
  //
  // ⚠️ READ THIS BEFORE ADDING A RESETTABLE INSTALL ID.
  //
  // [0,520] is 521 values = ~9 bits PER EVENT. That is narrowed, not closed: a
  // SEQUENCE of retained_control_week events reassembles arbitrary data — 5
  // events carry 6 ASCII characters, 8 carry a 64-bit id, 15 carry a UUID
  // (measured, not estimated).
  //
  // Today that is harmless because there is no transport and no install id, so
  // events are unlinkable — a receiver cannot tell which events came from the
  // same client, and an unordered multiset of week numbers from a mixed
  // population carries nothing. An install id is EXACTLY what makes the
  // sequence reassemblable, so it turns this into a live covert channel.
  //
  // The fix at that point is NOT a tighter range. DERIVE `week` SERVER-SIDE
  // from the install's first-seen timestamp and ignore the client's value: this
  // is a weekly retention ping, the server already knows the answer, and that
  // makes the channel 0 bits. Failing that, dedupe on (install_id, week),
  // reject non-monotonic values, and accept one event per install per week —
  // which caps the channel at ~9 bits total per install rather than per event.
  retained_control_week: { properties: { week: { integer: true, min: 0, max: 520 } } },
} as const satisfies Record<string, EventSpec>;

/**
 * `as const` is compile-time only — in-process code, or a compromised
 * dependency, can widen the allowlist or add an event at runtime. For a privacy
 * control that has to be a hard boundary, freeze it.
 */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}
deepFreeze(PRODUCT_EVENTS);

export type ProductEventName = keyof typeof PRODUCT_EVENTS;

export interface ValidatedEvent {
  name: ProductEventName;
  properties: Record<string, string | number>;
}

export type ValidationResult =
  | { ok: true; event: ValidatedEvent }
  | { ok: false; reason: string };

/** Raised by `ProductEventRejected.assert` for callers that prefer throwing. */
export class ProductEventRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProductEventRejected";
  }
  /** Unwrap a result, throwing on rejection. */
  static assert(result: ValidationResult): ValidatedEvent {
    if (!result.ok) throw new ProductEventRejected(result.reason);
    return result.event;
  }
}

export function validateProductEvent(
  name: ProductEventName,
  properties: Record<string, unknown>,
): ValidationResult {
  // hasOwnProperty, NOT a bare index: `PRODUCT_EVENTS["constructor"]` and
  // `["__proto__"]` resolve through the prototype chain, so a bare lookup let
  // nine off-allowlist names validate. Proven by review.
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_EVENTS, name)) {
    // Names the EXPECTED set, never the received token — the token is
    // caller-controlled and may itself be the thing we must not record.
    return { ok: false, reason: "event name is not on the product-event allowlist (roadmap §6.5)" };
  }
  const spec = PRODUCT_EVENTS[name] as EventSpec;

  // Null-prototype: a declared key can then never reach the `__proto__` setter.
  const out: Record<string, string | number> = Object.create(null);

  let entries: [string, unknown][];
  try {
    // Object.entries INVOKES getters, so a hostile or buggy getter throws from
    // inside the validator. This function is documented to RETURN a result;
    // throwing here means a caller's `if (!result.ok)` never runs, and under
    // Express 4 (which does not catch async rejections) the request hangs
    // rather than 500s.
    entries = Object.entries(properties);
  } catch {
    return { ok: false, reason: "event properties could not be read" };
  }

  for (const [key, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(spec.properties, key)) {
      // The RETURNED reason names no token (it may cross a trust boundary), but
      // an engineer wiring a new event needs to know which property was
      // refused. Log it here, where we are already inside the boundary.
      logger.debug({ event: name, property: key }, "product event rejected: undeclared property");
      // Same prototype hazard as the name lookup. JSON.parse('{"__proto__":…}')
      // produces an OWN enumerable "__proto__", so this is reachable from real
      // inbound payloads, not just hand-written objects.
      return {
        ok: false,
        reason: `event carries a property that is not declared for it — product events are default-deny, so declare it in PRODUCT_EVENTS or stop sending it`,
      };
    }
    const propSpec = spec.properties[key]!;

    if ("integer" in propSpec) {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        // -0 passes Number.isInteger and both bounds, and JSON.stringify(-0) is
        // "0" — so it is one bit that exists in memory and vanishes on the wire.
        // Harmless today; rejected so the schema means exactly what it says.
        Object.is(value, -0) ||
        value < propSpec.min ||
        value > propSpec.max
      ) {
        return {
          ok: false,
          reason: `a numeric property must be an integer between ${propSpec.min} and ${propSpec.max}`,
        };
      }
      out[key] = value;
      continue;
    }

    if (typeof value !== "string" || !propSpec.enum.includes(value)) {
      return {
        ok: false,
        reason: `a property value is not on its allowed list (expected one of: ${propSpec.enum.join(", ")})`,
      };
    }
    out[key] = value;
  }

  return { ok: true, event: { name, properties: { ...out } } };
}
