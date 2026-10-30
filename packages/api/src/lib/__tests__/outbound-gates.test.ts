import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  OUTBOUND_DISABLED_CODES,
  OUTBOUND_GATE_ENV,
  assertOutboundFeatureEnabled,
  disabledFeatureForTool,
  isOutboundFeatureEnabled,
  type OutboundFeature,
} from "../outbound-gates";
import { AppError, errorHandler } from "../../middleware/error";

const FEATURES: OutboundFeature[] = ["email", "outreach", "voice"];

afterEach(() => { vi.unstubAllEnvs(); });

describe("B-06 outbound gates", () => {
  it("uses the documented env names and stable error codes", () => {
    expect(OUTBOUND_GATE_ENV).toEqual({
      email: "OUTBOUND_EMAIL_ENABLED",
      outreach: "OUTREACH_SEQUENCES_ENABLED",
      voice: "VOICE_AGENT_ENABLED",
    });
    expect(OUTBOUND_DISABLED_CODES).toEqual({
      email: "EMAIL_SENDING_DISABLED",
      outreach: "OUTREACH_SEQUENCES_DISABLED",
      voice: "VOICE_AGENT_DISABLED",
    });
  });

  it.each(FEATURES)("%s is OFF when its flag is unset (production default)", (feature) => {
    for (const name of Object.values(OUTBOUND_GATE_ENV)) {
      vi.stubEnv(name, "x");
      delete process.env[name];
    }
    expect(isOutboundFeatureEnabled(feature)).toBe(false);
    expect(() => assertOutboundFeatureEnabled(feature)).toThrow(AppError);
  });

  it.each(FEATURES)("%s enables only for the literal \"true\"", (feature) => {
    for (const value of ["", "false", "1", "yes", "TRUE", " true"]) {
      vi.stubEnv(OUTBOUND_GATE_ENV[feature], value);
      expect(isOutboundFeatureEnabled(feature)).toBe(false);
    }
    vi.stubEnv(OUTBOUND_GATE_ENV[feature], "true");
    expect(isOutboundFeatureEnabled(feature)).toBe(true);
    expect(() => assertOutboundFeatureEnabled(feature)).not.toThrow();
  });

  it("flags are independent", () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    expect(isOutboundFeatureEnabled("email")).toBe(true);
    expect(isOutboundFeatureEnabled("outreach")).toBe(false);
    expect(isOutboundFeatureEnabled("voice")).toBe(false);
  });

  it("disabled feature serializes as 422 with a top-level code", () => {
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    let thrown: unknown;
    try { assertOutboundFeatureEnabled("voice"); } catch (err) { thrown = err; }
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    errorHandler(thrown as Error, {} as any, res as any, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      error: "Voice agent calls are temporarily unavailable.",
      details: undefined,
      code: "VOICE_AGENT_DISABLED",
    });
  });

  it("errors without a code keep the previous response shape", () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    errorHandler(new AppError(404, "Draft not found"), {} as any, res as any, vi.fn());
    expect(json).toHaveBeenCalledWith({ error: "Draft not found", details: undefined });
  });

  it("maps outbound agent tools to their gates", () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    expect(disabledFeatureForTool("make_outbound_call")).toBe("voice");
    expect(disabledFeatureForTool("email_send_sequence")).toBe("outreach");
    expect(disabledFeatureForTool("web_search")).toBeNull();

    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
    expect(disabledFeatureForTool("email_send_sequence")).toBe("email");

    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("VOICE_AGENT_ENABLED", "true");
    expect(disabledFeatureForTool("email_send_sequence")).toBeNull();
    expect(disabledFeatureForTool("make_outbound_call")).toBeNull();
  });
});
