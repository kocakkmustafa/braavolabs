import type { BenchSuiteDef } from ".";

/**
 * Audit trace suite — given a run trace, can the model answer
 * questions about it? Synthetic traces with planted edge cases
 * (missing reasoning, mis-routed delegation, looping tool call).
 * Judge grades correctness + citation of the right step number.
 */
export const auditTraceSuite: BenchSuiteDef = {
  slug: "audit-trace",
  name: "Audit trace comprehension",
  description:
    "Read a synthetic agent run trace, answer questions, and cite the offending step. Tests both reading comprehension and pinning behaviour to a precise audit row.",
  maxScorePerTask: 10,
  isPublic: true,
  tasks: [
    {
      id: "find-missing-reasoning",
      prompt:
        "Trace (excerpted):\n" +
        "  step 1 [reasoning: 'Pulled top 5 sources']  → web_search\n" +
        "  step 2 [reasoning: '']                       → summarise\n" +
        "  step 3 [reasoning: 'Draft email body']       → email_send\n" +
        "Which step violates the reasoning-required rule?",
      rubric: "Identifies step 2. Mentions the policy. Penalise for citing step 1 or 3.",
    },
    {
      id: "cost-anomaly-pin",
      prompt:
        "Run budget $1.00. Steps cost (USD): 0.10, 0.08, 0.42, 0.05. After step 3 the agent receives a cost_anomaly_stop. Which step triggered it?",
      rubric: "Identifies step 3. Shows the arithmetic (cumulative 0.60 / 1.00 = 60% but step 3 alone is 42% of budget so the per-step spike trips the anomaly).",
    },
    {
      id: "loop-detection",
      prompt:
        "Trace: same tool web_search invoked 6 times in a row with the same query string. What runtime stop should fire and which step number?",
      rubric: "Identifies loop_stop firing on step 5 (≥5 consecutive failures). Bonus: notes the stop is keyed on identical input hash, not just tool name.",
    },
    {
      id: "delegation-mis-route",
      prompt:
        "Hierarchical pipeline manager delegates 'send a $50 LinkedIn ad' to the 'researcher' agent. Worker has no ad_spend tool. What happens at the runtime?",
      rubric: "Recognises that the worker returns an unsuitable-tool error (no ad_spend in tool list). Notes the manager should re-delegate to a sales/ads worker. Penalise for hallucinating that the worker silently performs the action.",
    },
    {
      id: "cross-tenant-attempt",
      prompt:
        "BullMQ job enqueued with runId=R-1 and tenantId=T-A. The actual run R-1 belongs to T-B. What does the runner do on dequeue?",
      rubric: "Refuses execution. Cites the SEC-024 tenant assertion. Logs to activity_log. Penalise for proceeding with the run.",
    },
    {
      id: "approval-expiry",
      prompt:
        "Pending approval created 25 hours ago, status still PENDING. The approval-expiry cron runs every hour. What's its next action?",
      rubric: "Auto-reject the approval (24h TTL). Mentions the metering rollback that returns the run's quota slot.",
    },
    {
      id: "memory-deprecation",
      prompt:
        "A memory_item was promoted to 'approved' last month. Two new runs this week have contradicted it. Recommend a status transition.",
      rubric: "Recommends moving to 'deprecated'. Cites the lifecycle. Bonus: suggests writing the contradicting evidence onto the memory's metadata.",
    },
    {
      id: "spam-after-three",
      prompt:
        "Outreach sequence: contact X has had 3 sends, 0 replies. The next step would send a 4th. What does the runner do?",
      rubric: "Halts the sequence for that contact. Mentions spam_stop. Bonus: notes the rest of the sequence (other contacts) is unaffected.",
    },
    {
      id: "byok-quota-drift",
      prompt:
        "Tenant runs out of Anthropic credit mid-pipeline. The next agent step starts. What happens?",
      rubric: "Pipeline pauses with provider-error. Suggests trial Groq pool if FREE plan, else surfaces to the user. Penalise for silently downgrading models.",
    },
    {
      id: "audit-completeness",
      prompt:
        "A run has 12 steps but only 8 tool_calls rows. Is this normal or a bug?",
      rubric: "Mostly normal — some steps don't invoke tools (e.g. pure reasoning steps). Add caveat that the rule is 'every TOOL CALL is logged', not 'every STEP makes a tool call'. Penalise for declaring it a bug without that nuance.",
    },
  ],
};
