# Cross-Model Handoff Protocol (E3)

Durable, cross-session takeover of a run from one AI provider/model to another.
Where E2's provider-chain failover is **in-memory and single-process** (it dies
with the process), the handoff protocol persists the takeover state to the
database so **a different process or session can resume from where it left off**.

## Data model

- **`handoff_ledger`** — one row per handoff. Lifecycle:
  `OPEN` → `CLAIMED` → `COMPLETED`/`FAILED`; `CANCELLED` on operator cancel/rerun.
  Key columns: `runId`/`runStepId` (FK), `stepIndex`, `fromProvider`/`fromModel`,
  `toProvider`/`toModel`, `reason`, `checkpoint` (frozen canonical transcript,
  nullable until frozen), `gitState` (best-effort GitHub snapshot), `contextSummary`.
  Tenant-scoped with RLS (defense-in-depth; the checkpoint JSON carries tenant
  conversation data).
- **`run_steps.transcript`** — the *live* turn-boundary checkpoint. The agent
  loop writes the canonical `ChatMessage[]` here at the **end of every governed
  turn** (crash-safe carrier). NULLed when the step COMPLETEs — the durable copy
  lives in `handoff_ledger.checkpoint`.

## Checkpoint lifecycle & interrupt semantics

1. **Every turn end** → persist the canonical transcript to `run_steps.transcript`
   (errors swallowed; a checkpoint miss never kills the run).
2. **Every turn start** → the loop checks `run.status` and any OPEN handoff ledger.
   On a paused run or an OPEN handoff it **freezes** the ledger checkpoint (a copy
   of the live transcript — the live loop is the *single writer*, which is what
   makes the handoff claimable) and exits via `HandoffInterrupt`.
3. The executor maps `HandoffInterrupt` to an **INTERRUPTED** step: the step
   returns to `PENDING`, the run stays PAUSED/CANCELLED (no finalize).
4. A **step-boundary race guard** covers a handoff requested exactly as a step
   finishes (OPEN ledger, checkpoint still null): the completing step freezes it.

## Triggers

- **Manual** — `POST /runs/:id/handoff` opens an OPEN ledger and pauses the run;
  the live loop freezes the checkpoint at the next turn boundary.
- **Automatic** — the agent loop throws `ProviderExhaustedError` **only** when a
  failover-eligible chain is genuinely exhausted (explicit FAILOVER class, or a
  retry-exhausted TRANSIENT with an HTTP status). The executor catch opens a
  ledger **only** for this marker — never for generic errors ("No AI provider
  configured", Prisma failures, default-TRANSIENT). FATAL errors never trigger a
  handoff (the same request would fail on any provider). Ledger/approval writes
  are swallowed and never block marking the step FAILED.

## Takeover (resume)

`POST /runs/:id/continue` claims an OPEN ledger. Claim requires a **non-null
checkpoint** (409 `CHECKPOINT_PENDING` otherwise) with a **120 s stale-eshold**
recovery path — this is the double-execution lock: continue and a still-running
live loop can never both enqueue the same run. On claim the executor's
`resolveStepTakeover` sees the CLAIMED ledger for the step, resolves an
`AIClientConfig` for `toProvider` (tenant BYOK decrypt, or keyless-local with the
claim-time baseUrl), and runs the loop with `resumeMessages = checkpoint.messages`
plus a handoff note — no fresh user message is appended. Step COMPLETED → ledger
COMPLETED; step FAILED → ledger FAILED (a new handoff may open).

## Privacy rule (inherited from E2)

Only the tenant's **own BYOK keys** are dialed for a takeover (default →
`fallbackOrder`). The system Anthropic key is used **only** when the tenant sets
`allowSystemFallback = true` (default false) and is **never** offered to a
keyless FREE tenant. In production a keyless-local takeover **requires an explicit
baseUrl** (the server never falls back to `localhost` — server = orchestration
only).

## Approval & expiry

An automatic handoff creates an `Approval(HANDOFF)` **only when a viable
alternate provider exists** (a non-`fromProvider`, untripped tenant link); with
no viable target the ledger stays OPEN and the operator picks a provider from the
web/CLI. On `APPROVED` the claim runs **before** re-enqueue; a failed claim
cancels the enqueue and leaves the run FAILED + ledger OPEN. `REJECTED` leaves the
run FAILED and marks the ledger CANCELLED. The approval-expiry cron rejects the
approval after 24 h but **leaves the run FAILED and the ledger OPEN** (never
CANCELLED) — the handoff remains claimable indefinitely.

## Rerun & side-effect boundary

Re-running a run cancels any OPEN ledger for it (409 if already CLAIMED). The
takeover resumes at the **turn boundary** where the interrupt fired, so a tool
call already dispatched in the interrupted turn is not re-dispatched; work within
an in-flight turn is the side-effect window (bounded by the turn, not the step).

## Surfaces

- **CLI** — `braavo handoff <runId>`, `braavo continue <runId> --provider <P>`,
  `braavo handoffs [--open]` (409 retry built in).
- **Web** — `runs/[id]` HandoffPanel: start a handoff, pick a takeover provider
  from the key-masked `GET /settings/ai-config/providers` list, continue an OPEN
  ledger, view the ledger timeline. Forge palette, 6 locales.
- **Mobile** — zero code. The `HANDOFF` approval surfaces in the existing generic
  approvals queue and `HANDOFF_CREATED`/`HANDOFF_CLAIMED` events flow over the
  existing SSE stream (the EXTERNAL_CONTROL precedent).

## Git-awareness

`github.ts` exposes read-only `getGitHubPRStatus` / `getGitHubBranchStatus` /
`listGitHubPRs` and two low-risk registry tools; the handoff captures a
best-effort `gitState` snapshot into the ledger (null for tenants without a
GitHub integration — the handoff still works).
