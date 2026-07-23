/**
 * Relay control-plane contract — the wire format between a LOCAL session
 * (desktop app / CLI, Lane-A/B or R6 computer-use, running on the user's own
 * machine) and a cloud COMPANION (mobile panel) that observes and steers it.
 * Modeled after the Claude Code mobile-panel pattern: the local surface is
 * the source of truth and does the actual work; the cloud relay is a thin,
 * tenant-scoped mirror + command mailbox.
 *
 * Two message families, each a zod discriminated union on `type` (mirrors
 * the `RunEventBase.type` convention in @ai-company-os/core's events.ts):
 *
 *   SessionEvent    — LOCAL session → companion (status/output/approvals/audit)
 *   ControlCommand  — companion → LOCAL session (steer/approve/reject/kill)
 *
 * Naming note: `SessionEvent`'s "approval-request" variant carries its OWN
 * `kind` field (the governed action's kind, e.g. "shell.exec" — a mirror of
 * the R6 governance dialog). To avoid colliding with that inner field, the
 * union's OUTER discriminant is named `type`, not `kind` — same convention
 * `RunEvent` already uses in core.
 *
 * REDACTION RULE: this contract never intentionally carries a raw secret
 * (API key / token / password). Free-text fields (dialogText / summary /
 * decoded output) are bounded AND passed through `redact()` before they are
 * buffered or published — see redactSessionEventInput / redactControlCommand
 * below, applied by the relay's bus (bus.ts) at publish time.
 */
import { z } from "zod";

// ─── Bounds ─────────────────────────────────────────────────────────────
// Mirrors the existing steer route's bound (run/router.ts: `content.slice(0,
// 4000)`) for any free-text operator/agent message. Output is base64 of
// terminal/agent bytes — bounded generously (~150KB decoded) since it's
// meant for a live tail, not a full transcript dump.
export const MAX_TEXT_LEN = 4000;
export const MAX_OUTPUT_B64_LEN = 200_000;
export const MAX_ACTION_ID_LEN = 200;
export const MAX_ACTION_KIND_LEN = 120;
export const MAX_LABEL_LEN = 200;
export const MAX_CWD_LEN = 1024;

// ─── Redaction ──────────────────────────────────────────────────────────
// Defense-in-depth backstop, NOT a substitute for the contract never
// carrying raw secrets in the first place. Three simple, cheap patterns:
//   - `sk-...` style provider API key prefixes
//   - `Bearer <opaque>` authorization-header-shaped tokens
//   - long (>=32 char) opaque alnum/[-_.] runs (JWT/hex-secret shaped)
// This will over-redact some legitimate long identifiers (hashes, commit
// SHAs) — an acceptable false-positive rate for a mirrored, human-readable
// audit/approval feed where under-redaction is the far worse failure mode.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{32,}(?![A-Za-z0-9._-])/g,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "«redacted»");
  }
  return out;
}

// ─── SessionRegistration ────────────────────────────────────────────────
export const SURFACES = ["desktop", "cli"] as const;
export type Surface = (typeof SURFACES)[number];

export const SessionRegistrationSchema = z.object({
  surface: z.enum(SURFACES),
  label: z.string().trim().min(1).max(MAX_LABEL_LEN).optional(),
  cwd: z.string().trim().min(1).max(MAX_CWD_LEN).optional(),
});
export type SessionRegistration = z.infer<typeof SessionRegistrationSchema>;

// ─── SessionEvent (LOCAL session → companion) ──────────────────────────
// Governed-action approval mirror (R6 governance). `kind` here is the
// governed action's OWN kind (e.g. "shell.exec"), unrelated to the outer
// union discriminant.
export const ApprovalRequestEventSchema = z.object({
  type: z.literal("approval-request"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
  kind: z.string().trim().min(1).max(MAX_ACTION_KIND_LEN),
  dialogText: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Redacted turn summary — never the raw transcript.
export const AgentTurnEventSchema = z.object({
  type: z.literal("agent-turn"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Terminal/agent output, base64-encoded and bounded.
export const OutputEventSchema = z.object({
  type: z.literal("output"),
  textB64: z.string().min(1).max(MAX_OUTPUT_B64_LEN),
});

// Audit ledger line mirror — redacted summary, never raw ledger payload.
export const AuditEventSchema = z.object({
  type: z.literal("audit"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

export const SESSION_STATES = ["running", "idle", "ended"] as const;
export type SessionEventState = (typeof SESSION_STATES)[number];

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  state: z.enum(SESSION_STATES),
});

export const SessionEventInputSchema = z.discriminatedUnion("type", [
  ApprovalRequestEventSchema,
  AgentTurnEventSchema,
  OutputEventSchema,
  AuditEventSchema,
  StatusEventSchema,
]);
/** What the LOCAL session posts — no envelope yet (server assigns it). */
export type SessionEventInput = z.infer<typeof SessionEventInputSchema>;

/** What the companion receives — input + server-assigned envelope. */
export type SessionEvent = SessionEventInput & {
  sessionId: string;
  seq: number;
  ts: string;
};

/**
 * Apply the redaction rule to a parsed SessionEventInput's free-text
 * fields. `output` is base64 — decoded, redacted, and re-encoded so the
 * pattern match runs against the actual text, not its base64 encoding.
 * Malformed base64 is treated conservatively (replaced wholesale) rather
 * than left un-redacted.
 */
export function redactSessionEventInput(ev: SessionEventInput): SessionEventInput {
  switch (ev.type) {
    case "approval-request":
      return { ...ev, dialogText: redact(ev.dialogText) };
    case "agent-turn":
      return { ...ev, summary: redact(ev.summary) };
    case "audit":
      return { ...ev, summary: redact(ev.summary) };
    case "output": {
      let decoded: string;
      try {
        decoded = Buffer.from(ev.textB64, "base64").toString("utf8");
      } catch {
        return { ...ev, textB64: Buffer.from("«unreadable output»", "utf8").toString("base64") };
      }
      return { ...ev, textB64: Buffer.from(redact(decoded), "utf8").toString("base64") };
    }
    case "status":
      return ev; // no free text to redact
  }
}

// ─── ControlCommand (companion → LOCAL session) ────────────────────────
export const SteerCommandSchema = z.object({
  type: z.literal("steer"),
  message: z.string().trim().min(1).max(MAX_TEXT_LEN),
});
export const ApproveCommandSchema = z.object({
  type: z.literal("approve"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const RejectCommandSchema = z.object({
  type: z.literal("reject"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const KillCommandSchema = z.object({
  type: z.literal("kill"),
});

export const ControlCommandSchema = z.discriminatedUnion("type", [
  SteerCommandSchema,
  ApproveCommandSchema,
  RejectCommandSchema,
  KillCommandSchema,
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

/** What the LOCAL session receives — command + server-assigned envelope. */
export type ControlCommandMessage = ControlCommand & {
  sessionId: string;
  seq: number;
  ts: string;
};

/** Symmetric redaction pass for outbound commands (only `steer` carries free text). */
export function redactControlCommand(cmd: ControlCommand): ControlCommand {
  if (cmd.type === "steer") {
    return { ...cmd, message: redact(cmd.message) };
  }
  return cmd;
}
