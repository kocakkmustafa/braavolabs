/**
 * Relay protocol contract — zod parsing (malformed rejection) and the
 * redaction rule applied to free-text fields before they can reach a
 * companion or the buffer.
 */
import { describe, it, expect } from "vitest";
import {
  SessionRegistrationSchema,
  SessionEventInputSchema,
  ControlCommandSchema,
  redact,
  redactSessionEventInput,
  redactControlCommand,
  MAX_TEXT_LEN,
} from "../protocol";

describe("SessionRegistrationSchema", () => {
  it("accepts a minimal desktop registration", () => {
    const parsed = SessionRegistrationSchema.parse({ surface: "desktop" });
    expect(parsed.surface).toBe("desktop");
  });

  it("accepts cli surface with label + cwd", () => {
    const parsed = SessionRegistrationSchema.parse({ surface: "cli", label: "laptop", cwd: "/Users/x/project" });
    expect(parsed).toMatchObject({ surface: "cli", label: "laptop", cwd: "/Users/x/project" });
  });

  it("rejects an unrecognized surface", () => {
    expect(() => SessionRegistrationSchema.parse({ surface: "tablet" })).toThrow();
  });

  it("rejects a missing surface", () => {
    expect(() => SessionRegistrationSchema.parse({})).toThrow();
  });
});

describe("SessionEventInputSchema — malformed rejection", () => {
  it("accepts a well-formed approval-request", () => {
    const parsed = SessionEventInputSchema.parse({
      type: "approval-request",
      actionId: "act-1",
      kind: "shell.exec",
      dialogText: "Run `rm -rf build/`?",
    });
    expect(parsed.type).toBe("approval-request");
  });

  it("rejects approval-request missing dialogText", () => {
    expect(() =>
      SessionEventInputSchema.parse({ type: "approval-request", actionId: "act-1", kind: "shell.exec" }),
    ).toThrow();
  });

  it("rejects an unrecognized event type (discriminant miss)", () => {
    expect(() => SessionEventInputSchema.parse({ type: "not-a-real-kind", summary: "hi" })).toThrow();
  });

  it("accepts a well-formed agent-turn / audit / status / output event", () => {
    expect(SessionEventInputSchema.parse({ type: "agent-turn", summary: "Wrote 3 files." }).type).toBe("agent-turn");
    expect(SessionEventInputSchema.parse({ type: "audit", summary: "approved shell.exec" }).type).toBe("audit");
    expect(SessionEventInputSchema.parse({ type: "status", state: "running" }).type).toBe("status");
    expect(SessionEventInputSchema.parse({ type: "output", textB64: Buffer.from("hi").toString("base64") }).type).toBe(
      "output",
    );
  });

  it("rejects status with an invalid state", () => {
    expect(() => SessionEventInputSchema.parse({ type: "status", state: "sleeping" })).toThrow();
  });

  it("rejects output with an empty textB64", () => {
    expect(() => SessionEventInputSchema.parse({ type: "output", textB64: "" })).toThrow();
  });

  it("rejects a summary longer than the bound", () => {
    expect(() =>
      SessionEventInputSchema.parse({ type: "agent-turn", summary: "x".repeat(MAX_TEXT_LEN + 1) }),
    ).toThrow();
  });

  it("rejects extra unknown top-level junk mixed into a valid shape only if it breaks the literal (sanity: discriminant still required)", () => {
    // zod discriminatedUnion requires the literal `type` field to be present and matching.
    expect(() => SessionEventInputSchema.parse({ actionId: "x", kind: "y", dialogText: "z" })).toThrow();
  });
});

describe("ControlCommandSchema — malformed rejection", () => {
  it("accepts steer / approve / reject / kill", () => {
    expect(ControlCommandSchema.parse({ type: "steer", message: "slow down" }).type).toBe("steer");
    expect(ControlCommandSchema.parse({ type: "approve", actionId: "act-1" }).type).toBe("approve");
    expect(ControlCommandSchema.parse({ type: "reject", actionId: "act-1" }).type).toBe("reject");
    expect(ControlCommandSchema.parse({ type: "kill" }).type).toBe("kill");
  });

  it("rejects steer with an empty message", () => {
    expect(() => ControlCommandSchema.parse({ type: "steer", message: "" })).toThrow();
  });

  it("rejects approve without actionId", () => {
    expect(() => ControlCommandSchema.parse({ type: "approve" })).toThrow();
  });

  it("rejects an unrecognized command kind", () => {
    expect(() => ControlCommandSchema.parse({ type: "reboot" })).toThrow();
  });
});

describe("redact()", () => {
  it("redacts sk-prefixed provider keys", () => {
    expect(redact("here is sk-ABCDEFGHIJ1234567890 for you")).toBe("here is «redacted» for you");
  });

  it("redacts Bearer-style tokens", () => {
    expect(redact("Authorization: Bearer abcDEF123.token-value_here")).toBe("Authorization: «redacted»");
  });

  it("redacts long opaque alnum runs (JWT/hex-secret shaped)", () => {
    const longToken = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";
    expect(redact(`token=${longToken}`)).toBe("token=«redacted»");
  });

  it("leaves ordinary short text untouched", () => {
    expect(redact("Wrote 3 files and ran the tests.")).toBe("Wrote 3 files and ran the tests.");
  });
});

describe("redactSessionEventInput()", () => {
  it("redacts approval-request dialogText", () => {
    const ev = redactSessionEventInput({
      type: "approval-request",
      actionId: "act-1",
      kind: "shell.exec",
      dialogText: "export KEY=sk-ABCDEFGHIJ1234567890 && run",
    });
    expect(ev.type).toBe("approval-request");
    expect((ev as any).dialogText).toBe("export KEY=«redacted» && run");
  });

  it("redacts agent-turn and audit summaries", () => {
    const secret = "Bearer aaaaaaaaaaaaaaaaaaaaaaaa";
    const turn = redactSessionEventInput({ type: "agent-turn", summary: `used ${secret} to call the API` });
    const audit = redactSessionEventInput({ type: "audit", summary: `approved with ${secret}` });
    expect((turn as any).summary).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
    expect((audit as any).summary).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("decodes, redacts, and re-encodes output textB64", () => {
    const raw = "leaking sk-ABCDEFGHIJ1234567890 in terminal output";
    const ev = redactSessionEventInput({ type: "output", textB64: Buffer.from(raw, "utf8").toString("base64") });
    const decoded = Buffer.from((ev as any).textB64, "base64").toString("utf8");
    expect(decoded).toBe("leaking «redacted» in terminal output");
  });

  it("leaves status events untouched (no free text)", () => {
    const ev = redactSessionEventInput({ type: "status", state: "idle" });
    expect(ev).toEqual({ type: "status", state: "idle" });
  });
});

describe("redactControlCommand()", () => {
  it("redacts a steer message", () => {
    const cmd = redactControlCommand({ type: "steer", message: "use key sk-ABCDEFGHIJ1234567890 next" });
    expect((cmd as any).message).toBe("use key «redacted» next");
  });

  it("leaves approve/reject/kill untouched (no free text)", () => {
    expect(redactControlCommand({ type: "approve", actionId: "a1" })).toEqual({ type: "approve", actionId: "a1" });
    expect(redactControlCommand({ type: "reject", actionId: "a1" })).toEqual({ type: "reject", actionId: "a1" });
    expect(redactControlCommand({ type: "kill" })).toEqual({ type: "kill" });
  });
});
