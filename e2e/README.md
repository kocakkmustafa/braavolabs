# E2E (BR-P0-005)

Playwright journeys against the **real** API and the **real** Next.js UI, backed
by a throwaway PostgreSQL. No mocks.

## Run

```bash
bash e2e/prepare.sh          # throwaway DB + schema + build + clear rate limits
pnpm exec playwright test
```

`prepare.sh` **drops and recreates** `aicos_e2e`. Point `E2E_DB_NAME` elsewhere
if that name is taken, and never aim it at a database you care about.

`playwright.config.ts` boots both servers itself (API on 4310, UI on 4311 —
override with `E2E_API_PORT` / `E2E_UI_PORT`, see `e2e/ports.ts`), so
the test command is self-contained — there is no manual step to forget and then
misdiagnose.

## Coverage

| Spec | Journey |
|---|---|
| `smoke.spec.ts` | harness liveness — tells "app broken" apart from "harness never started" |
| `onboarding-first-run.spec.ts` | register → session → first company (the activation gate's journey) |
| `approval.spec.ts` | approvals queue, auth requirement, cross-tenant decision refusal |
| `billing.spec.ts` | pricing page, per-route auth, tenant-scoped state, IAP webhook reachability |
| `ref-chat.spec.ts` | chat: greeting classified as chat; tool-less agent run returns the fake model's reply (API + run page) |
| `ref-draft-email.spec.ts` | agent saves a PENDING EMAIL draft via `create_draft`; nothing is sent (API + `/drafts` UI) |
| `ref-negative-outbound.spec.ts` | negative: gated outbound tools refused with gate codes, no approval row; money tool stops at a PENDING approval and never runs when rejected |
| `ref-research.spec.ts` | research stays off the network: tool-less agent returns a sourced summary; `web_research_deep` opens a session that, with no search provider (keys blanked in the config), never completes or gathers sources |
| `ref-code-fix-pr-dryrun.spec.ts` | code fix: `create_pull_request` (dry-run tool) refused by the 03c deploy/merge gate (`DEPLOY_MERGE_TOOLS_DISABLED`), no approval row, no GitHub egress, receipt absent (receipts need JOB_STATE_DUAL_WRITE, off) so nothing is VERIFIED, code-summary empty. Flag-ON dry-run (`prUrl:null`) is not run here: the flag is API-process-global; it is covered by the tool-executor/outbound-gate unit tests |
| `ref-social-draft.spec.ts` | agent saves a PENDING LinkedIn `SOCIAL_POST` draft via `social_create_post`; PUBLISHED/APPROVED empty, only the fake model contacted (API + `/drafts` UI) |

## How the fake LLM works (BRA-P0-10)

`e2e/support/fake-llm.ts` is a tiny `node:http` OpenAI-compatible server on
`127.0.0.1:4314` (`E2E_FAKE_LLM_PORT`), started by Playwright's `webServer`.
The API runs with `OFFLINE_MODE=true` (the SSRF guard then allows a loopback
CUSTOM provider and cloud providers stay cut), and each `ref-*` spec points its
own throwaway tenant at `http://127.0.0.1:4314/v1` through
`PUT /settings/ai-config` (`support/journey.ts`). A fresh tenant is
`MANUAL_REVIEW`, which the billing gate bars from self-hosted providers, so the
helper flips that tenant's plan row to `TEAM` with `psql` (test setup only).

The scenario is chosen by a marker in the agent's system prompt,
`[e2e:<scenario>;key=value]`. The server is stateless: no tool message at the
end of the conversation means turn one (a `tool_calls` reply or a plain
answer), a trailing `tool` message means the tool result came back and the model
answers. Every request is recorded; specs read `GET /__requests` and
`POST /__reset` via `support/fake-llm-client.ts` to prove what the model saw and
that no other peer was called. Outbound gate flags are never set, so they stay
off.

## Things that will bite you

**Rate limiting.** `/auth/register` allows **5 requests per hour per IP**, and
every test shares `127.0.0.1`. The suite needs more than five, so `helpers.ts`
clears the `rl:*` Redis counters before each registration. That is test-state
cleanup — the product limit is deliberately untouched.

**`next start` vs `standalone`.** Production serves the UI from Next's
`output: "standalone"` bundle. That bundle is unusable on a workspace whose
`.npmrc` relocates pnpm's virtual store (the iCloud eviction workaround): Next
bakes traced module paths in at build time, and the result dies with
`MODULE_NOT_FOUND` before serving anything. The config therefore uses
`next start`, which warns and then serves the real built app. Set
`E2E_UI_STANDALONE=1` to use the standalone entry where it works (CI).

**Static assets.** Next does not copy `.next/static` or `public/` into the
standalone bundle; `prepare.sh` links them in. Without that the server starts
and every asset 404s, which reads like an app bug rather than a packaging step.
