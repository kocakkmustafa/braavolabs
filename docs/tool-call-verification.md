# Tool Call Propagation — End-to-end Verification

QA agent flagged that production has **3 pipeline runs but 0 tool_call
records**. CLAUDE.md rule #1 says "every tool call is logged" — so
either rule #1 is silently broken, OR those 3 runs never invoked Claude.
This doc walks through how to verify which.

## Code path (verified by static analysis)

The wire is correct in source:

```
RunsRouter.startRun()
  → pipelineExecutor.executeRun()
    → for each step:
        → runAgentLoop({ govContext: { runId, runStepId, ... } })
          → runAnthropicLoop or runNonAnthropicAgentLoop
            → returns AgentLoopResult { turns: [{ toolCalls: [...] }] }
        → logToolCalls(runStep.id, result)
          → for each turn.toolCalls:
              → prisma.toolCall.create({ data: { runStepId, toolName, ... } })
```

**File references:**
- `packages/api/src/modules/pipeline/executor.ts:102-126` — agent loop call + logging
- `packages/api/src/modules/pipeline/executor.ts:246-270` — `logToolCalls()` writes to DB
- `packages/api/src/modules/agent/claude.ts:299-344` — `runAgentLoop` dispatches to provider

So if a pipeline ran AND the agent called Claude AND Claude returned a
tool call → `tool_calls` row IS written.

## Three explanations for "0 tool_calls"

### 1. Agent didn't use any tools (text-only response)

Most likely cause. If the agent's system prompt says "respond with a
plain text summary" and the agent does, no tools fire. The agent loop
completes with:
```js
result = { turns: [{ toolCalls: [], content: "..." }], finalContent: "..." }
```

`logToolCalls` iterates over an empty array → 0 rows written. This is
correct behavior, not a bug.

**Verify with:**
```sql
SELECT
  rs.id, rs.status, rs.cost_usd,
  jsonb_array_length(rs.output->'turns') AS turn_count,
  rs.completed_at - rs.started_at AS duration
FROM run_steps rs
WHERE rs.completed_at IS NOT NULL
ORDER BY rs.completed_at DESC LIMIT 5;
```
- `cost_usd > 0` → Claude was called
- `turn_count > 0` → Loop ran
- `cost_usd > 0` AND `turn_count > 0` AND no `tool_calls` row → text-only response (correct)

### 2. No AI key configured → loop short-circuits

If the tenant has no `UserAIConfig` AND the system has no
`ANTHROPIC_API_KEY` env, `runAgentLoop` will fail when constructing the
Anthropic client. The error propagates up, `logToolCalls` never runs,
and the run step is marked FAILED.

**Verify with:**
```sql
SELECT status, COUNT(*) FROM run_steps GROUP BY status;
```
- If you see FAILED runs → check the error column, look for
  "Anthropic API key required" or similar.

### 3. Local-mode CLI path (`isLocalMode = true`)

If `LLM_PROVIDER=local` is set, the loop uses a local Claude CLI process
instead of the Anthropic API. Tool calls work the same way — `runLocalAgentLoop`
returns the same `AgentLoopResult` shape. So `tool_calls` should still
populate.

**Verify with:**
```bash
ssh ubuntu@... 'sudo grep "^LLM_PROVIDER=" /opt/braavolabs/app/.env'
# Should be `LLM_PROVIDER=api` (or unset, which defaults to api)
```

## End-to-end verification test (run when prod is healthy)

Once the server is back online, run this test to PROVE the wire works:

```bash
# 1. Login as a known tenant (replace with real creds)
TOKEN=$(curl -sS -X POST https://braavolabs.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"kocakmkaan@gmail.com","password":"..."}' \
  | jq -r .token)

# 2. Create a tiny test company
COMPANY=$(curl -sS -X POST https://braavolabs.com/api/v1/companies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"description":"Test company that summarises one Reddit post per day"}' \
  | jq -r .id)
echo "Company: $COMPANY"

# 3. Wait 30 seconds for the company builder to finish
sleep 30

# 4. Get the first pipeline + trigger a run
PIPELINE=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://braavolabs.com/api/v1/companies/$COMPANY/pipelines" | jq -r '.[0].id')

RUN=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  "https://braavolabs.com/api/v1/pipelines/$PIPELINE/run" \
  | jq -r .runId)
echo "Run: $RUN"

# 5. Watch the run progress (SSE)
curl -sS -N -H "Authorization: Bearer $TOKEN" \
  "https://braavolabs.com/api/v1/runs/$RUN/stream" &
SSE_PID=$!

# 6. After completion, check tool_calls
sleep 60
kill $SSE_PID 2>/dev/null

# 7. SQL inspection
ssh ubuntu@... 'sudo docker exec aicos-postgres psql -U aicos -d aicos_prod -c "
  SELECT
    tc.tool_name,
    tc.status,
    tc.duration_ms,
    rs.id AS run_step_id
  FROM tool_calls tc
  JOIN run_steps rs ON tc.run_step_id = rs.id
  WHERE rs.run_id = '"'"'$RUN'"'"'
  ORDER BY tc.created_at;
"'
```

**Pass criteria:**
- Run completes with status = COMPLETED
- ≥1 `tool_calls` row is written linked to the run's steps
- `run_steps.cost_usd > 0` (Claude was actually called)
- Each tool_call has `status` = COMPLETED or FAILED (not stuck PENDING)

If this test passes, CLAUDE.md rule #1 is intact and the "0 tool_calls
in production" was just an artifact of low usage / specific pipeline
shapes that didn't need tools.

If this test FAILS — look at the run_steps.output and any FAILED
run_step.error to debug. The most common cause is missing/invalid
ANTHROPIC_API_KEY.

## Ongoing monitoring

Add this query to UptimeRobot / Sentry / PagerDuty as a synthetic
health check:

```sql
-- Alert if no tool_calls written in last 24h despite >0 runs
SELECT
  (SELECT COUNT(*) FROM runs WHERE created_at > NOW() - INTERVAL '24 hours') AS runs_24h,
  (SELECT COUNT(*) FROM tool_calls WHERE created_at > NOW() - INTERVAL '24 hours') AS tool_calls_24h
;
-- runs_24h > 0 AND tool_calls_24h = 0 → silent breakage
```

Once we have ≥10 paying customers running real workloads, set up an
alert on this ratio dropping below 1.0 over a 6-hour window.
