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

/** A property may be a fixed set of strings, or a number. Never free text. */
type PropSpec = { enum: readonly string[] } | { number: true };

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
  paid: { properties: { plan: { enum: ["creator", "pro", "business"] } } },
  retained_control_week: { properties: { week: { number: true } } },
} as const satisfies Record<string, EventSpec>;

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
  const spec = (PRODUCT_EVENTS as Record<string, EventSpec | undefined>)[name];
  if (!spec) {
    return { ok: false, reason: `"${name}" is not on the product-event allowlist (roadmap §6.5)` };
  }

  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(properties)) {
    const propSpec = spec.properties[key];
    if (!propSpec) {
      // The default-deny guarantee. Naming the event and property makes the
      // fix obvious: declare it here, or stop sending it.
      return {
        ok: false,
        reason: `"${key}" is not a declared property of "${name}" — product events are default-deny, so add it to PRODUCT_EVENTS or stop sending it`,
      };
    }
    if ("number" in propSpec) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `"${key}" on "${name}" must be a finite number` };
      }
      out[key] = value;
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, reason: `"${key}" on "${name}" must be one of: ${propSpec.enum.join(", ")}` };
    }
    if (!propSpec.enum.includes(value)) {
      // Deliberately does NOT echo the value: if it IS a leaked prompt, the
      // rejection message would become the leak.
      return {
        ok: false,
        reason: `"${key}" on "${name}" is not an allowed value (expected one of: ${propSpec.enum.join(", ")})`,
      };
    }
    out[key] = value;
  }

  return { ok: true, event: { name, properties: out } };
}
