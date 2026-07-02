/**
 * Run event contract — the single wire format for live run activity.
 *
 * One schema, streamed three ways:
 *   • Web   — Server-Sent Events (SSE), `seq` doubles as the Last-Event-ID
 *             resume cursor.
 *   • Mobile — WebSocket / push envelope.
 *   • CLI   — stdout JSON lines (planned).
 *
 * Modeled on the AG-UI event taxonomy (lifecycle · message · tool · state ·
 * human-in-the-loop), tailored to Braavolabs' runs / run_steps / tool_calls /
 * approvals domain. Keeping the vocabulary in `core` means the API emitter,
 * the web client, the mobile client, and the CLI all agree on the wire shape
 * without copy-pasting string literals.
 *
 * This file is intentionally types-only (no runtime deps) — the SSE/WS
 * encoders live in `packages/api` and the decoders in the UI clients.
 */

export type RunEventType =
  // ── Run lifecycle ──────────────────────────────────────────────
  | "RUN_STARTED"
  | "RUN_STATUS" // status transition (PAUSED, WAITING_APPROVAL, CANCELLED, …)
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  // ── Step lifecycle ─────────────────────────────────────────────
  | "STEP_STARTED"
  | "STEP_DELTA" // incremental agent text / reasoning chunk
  | "STEP_COMPLETED"
  | "STEP_FAILED"
  // ── Tool calls ─────────────────────────────────────────────────
  | "TOOL_CALL_START"
  | "TOOL_CALL_END"
  // ── Cost ───────────────────────────────────────────────────────
  | "COST_UPDATE"
  // ── Human-in-the-loop (the v2 moat) ────────────────────────────
  | "APPROVAL_REQUESTED" // spend / risk gate — operator must approve|reject
  | "INPUT_REQUESTED" // agent asked the human a question, awaiting free-text
  | "STEERING_APPLIED" // operator injected a prompt to steer a specific agent
  // ── Provider orchestration (E2/T7 — auto-mode failover) ────────
  | "PROVIDER_FAILOVER" // the agent loop advanced to the next provider in the tenant's chain
  // ── Transport keepalive ────────────────────────────────────────
  | "HEARTBEAT";

/** Every event carries this envelope. */
export interface RunEventBase {
  type: RunEventType;
  runId: string;
  /**
   * Monotonic, per-run sequence number. Clients send the last value back as
   * the SSE `Last-Event-ID` header on reconnect; the server replays anything
   * with a higher `seq` so no events are missed across a dropped connection.
   */
  seq: number;
  /** ISO-8601 emit time (server clock). */
  ts: string;
}

export interface RunStartedEvent extends RunEventBase {
  type: "RUN_STARTED";
  pipelineId: string;
  pipelineName?: string;
}

export interface RunStatusEvent extends RunEventBase {
  type: "RUN_STATUS";
  status: string; // RunStatus enum value
  reason?: string;
}

export interface RunCompletedEvent extends RunEventBase {
  type: "RUN_COMPLETED";
  costUsd: number;
  durationMs?: number;
}

export interface RunFailedEvent extends RunEventBase {
  type: "RUN_FAILED";
  error: string;
  costUsd?: number;
}

export interface StepStartedEvent extends RunEventBase {
  type: "STEP_STARTED";
  stepId: string;
  stepIndex: number;
  name: string;
  agentId?: string;
  agentRole?: string;
}

export interface StepDeltaEvent extends RunEventBase {
  type: "STEP_DELTA";
  stepId: string;
  /** Incremental text chunk (reasoning or output). */
  delta: string;
}

export interface StepCompletedEvent extends RunEventBase {
  type: "STEP_COMPLETED";
  stepId: string;
  reasoning?: string;
  costUsd: number;
}

export interface StepFailedEvent extends RunEventBase {
  type: "STEP_FAILED";
  stepId: string;
  error: string;
}

export interface ToolCallStartEvent extends RunEventBase {
  type: "TOOL_CALL_START";
  stepId: string;
  toolCallId: string;
  toolName: string;
}

export interface ToolCallEndEvent extends RunEventBase {
  type: "TOOL_CALL_END";
  stepId: string;
  toolCallId: string;
  toolName: string;
  status: "COMPLETED" | "FAILED";
  durationMs?: number;
  error?: string;
}

export interface CostUpdateEvent extends RunEventBase {
  type: "COST_UPDATE";
  costUsd: number;
  budgetUsd?: number | null;
}

export interface ApprovalRequestedEvent extends RunEventBase {
  type: "APPROVAL_REQUESTED";
  approvalId: string;
  stepId?: string;
  description: string;
  amountUsd?: number | null;
}

export interface InputRequestedEvent extends RunEventBase {
  type: "INPUT_REQUESTED";
  interruptId: string;
  stepId?: string;
  agentId?: string;
  /** The question the agent is asking the human. */
  question: string;
}

export interface SteeringAppliedEvent extends RunEventBase {
  type: "STEERING_APPLIED";
  stepId?: string;
  /** Which agent the operator's instruction was routed to. */
  targetAgentId?: string;
  /** Echo of the injected instruction (truncated for the stream). */
  instruction: string;
}

/**
 * E2/T7 — a turn died with a FAILOVER-class provider error (auth/quota, or
 * retry-exhausted transient) and the loop re-projected its canonical
 * transcript onto the NEXT provider in the tenant's chain (BYOK default →
 * fallbackOrder links → counted trial → opt-in system). Live visibility on
 * SSE/WS; the durable audit copy is the `activity_log` row the loop writes
 * alongside this event (run events live in Redis only).
 */
export interface ProviderFailoverEvent extends RunEventBase {
  type: "PROVIDER_FAILOVER";
  stepId?: string;
  /** Provider that failed (AIProviderType value, e.g. "DEEPSEEK"). */
  from: string;
  /** Provider that took over (e.g. "GROQ"). */
  to: string;
  /** Error class + truncated provider error that triggered the switch. */
  reason: string;
}

export interface HeartbeatEvent extends RunEventBase {
  type: "HEARTBEAT";
}

/** Discriminated union of every event that can appear on a run stream. */
export type RunEvent =
  | RunStartedEvent
  | RunStatusEvent
  | RunCompletedEvent
  | RunFailedEvent
  | StepStartedEvent
  | StepDeltaEvent
  | StepCompletedEvent
  | StepFailedEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | CostUpdateEvent
  | ApprovalRequestedEvent
  | InputRequestedEvent
  | SteeringAppliedEvent
  | ProviderFailoverEvent
  | HeartbeatEvent;

// ── Human-in-the-loop interrupts (Phase 1 — mid-run steering) ────────────
//
// A run can be interrupted in three ways. `APPROVAL` is the existing spend
// gate; `INPUT` and `STEER` are new in v2. They surface on web + mobile and
// resume the BullMQ job from a persisted checkpoint once answered.

export type RunInterruptKind = "APPROVAL" | "INPUT" | "STEER";

/**
 * An operator → agent message queued against a running run. Drained by the
 * agent loop at the top of each turn:
 *   • STEER — appended as guidance so the operator can redirect the agent.
 *   • INPUT — the answer to an agent's `ask_user` question; unblocks the run.
 */
export interface SteeringMessage {
  id: string;
  runId: string;
  /** Route to a specific agent; null = applies to whichever agent is active. */
  targetAgentId?: string | null;
  kind: Extract<RunInterruptKind, "INPUT" | "STEER">;
  content: string;
  /** userId of the operator who sent it (audit). */
  createdBy?: string;
  createdAt: string;
  /** Set once the agent loop has consumed it. */
  consumedAt?: string | null;
}
