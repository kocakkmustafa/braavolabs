# Braavolabs v2 — Build Status & Deploy Handoff

> 2026-06-01 · branch **`feat/v2`** (web) + **`feat/v2`** (mobile repo `Apps/Braavo`)
> **NOT pushed, NOT deployed** — awaiting founder review + deploy approval.
> Verification to date is **tsc/type-check + unit tests only** (108 green). No runtime/device test yet.

## What shipped (by vision pillar)

| # | Pillar | Status | Where |
|---|--------|--------|-------|
| 1 | Visual/editable builder + per-agent control + live logs | ✅ | `/pipelines/[id]`: **List + Graph views** (dep-free DAG topology `PipelineGraph`) + **parallel-aware step editor** (add/reorder/remove/∥-group, agent picker), editable settings; live `/runs/[id]` + company run view via real-time SSE, RunStepHeatmap. (Interactive React-Flow drag/connect = follow-on.) |
| 2 | **HITL: mid-run steer + agent↔human Q&A** (the moat) | ✅ end-to-end | `SteeringMessage` model; agent-loop drains STEER+INPUT each turn (`claude.ts`); `ask_user` tool → INPUT approval + WAITING_APPROVAL + push; `POST /runs/:id/steer`; answer via `decideApproval(note)`; web steer box + answer card; mobile steer + answer. |
| 3 | BYOK + model/provider choice | ✅ (pre-existing) | 12-provider router `services/ai-client.ts`; settings UI. |
| 4 | Connect & monitor external automations | ✅ end-to-end | `ExternalConnection`/`ExternalRun` schema + poller + CRUD API + `/connections` web UI. **Adapters: n8n + Make (API v2) + generic REST; Zapier→generic** (no public task-history API). 12 adapter unit tests. |
| 5 | Mobile pocket control | ✅ core | `Apps/Braavo` run-detail screen (live polling, steer, ask_user answer), trigger→detail + push deep-link. |
| 6 | Fully-offline on-device Gemma | ✅ scaffold | Desktop offline via Ollama/LM Studio (pre-existing) + machine-bound encrypted bundle. **Mobile**: offline-mode toggle + persisted pref + `lib/onDeviceLLM` backend-register seam (no fake native binding) + Gemma 3n model list + 6-locale i18n + `docs/PHASE4-ONDEVICE.md` runbook. Native model binding ships with a standalone EAS build. |
| 7 | CLI | ✅ | dep-free `packages/cli` (`braavo login/runs/run/steer/connections`). |

**Also:** real-time SSE (replaced 3s polling), AG-UI event contract, NL→pipeline creation, sidebar Connections link, **full i18n sweep (every client page, 10 namespaces × 6 locales)**, **2 new starter templates** (Proposal Writer, Content Repurposer → 6 total).

## Commits (feat/v2)
- **web (36):** master-plan → `/pipelines/[id]` → AG-UI contract → SSE → live run views → HITL (steer+ask_user) → NL-create → external (schema/poller/CRUD/UI) → CLI → BUILD-STATUS → **i18n sweep ×6 pages** → Phase-5 plan → **Make+generic adapters** → **parallel step editor** → **DAG view** → **+2 starter templates**.
- **mobile (4):** RunDetail client → run-detail screen → nav → **Phase-4 offline scaffold**.

## Verification
- `core` 27/27 + `api` 93/93 vitest = **120 pass** (no regressions; +12 adapter tests, starter catalog 6 validated).
- All packages `tsc --noEmit` clean (core/api/ui/cli). Mobile tsc clean modulo a pre-existing duplicate-`@types` (`TS2688 "node 2"`) env artifact — filter with `grep -vE TS2688`.
- **`next build` GREEN** — all 38 UI routes compile + prerender for production after the full i18n sweep (validates t()/t.rich/dynamic-key usage across every localized page).
- **Not yet done:** runtime smoke (live SSE/ask_user/poller), mobile device/EAS build.

## Deploy plan (needs approval — production mutation)
GitHub Actions is billing-suspended → **manual SSH** to `ubuntu@63.180.74.27` (see `Apps/Braavo/MANUAL-DEPLOY.md` flow). Steps:
1. **Review** feat/v2 diff; merge to `main` (or deploy the branch).
2. `pnpm install` (registers `packages/cli`; no new deps).
3. **Migrations (2):** `20260601074546_v2_steering_hitl`, `20260601083141_v2_external_monitoring` — both additive/backward-compatible. Apply via `prisma migrate deploy` on the prod DB.
4. Confirm `ENCRYPTION_KEY` set (external-connection creds use it).
5. Rebuild + restart `aicos-api` + `aicos-ui` (Lightsail manual build; RAM-tight → sequential).
6. **Runtime smoke:** trigger a run + watch SSE; `ask_user` pause→answer→resume; post a steering message; add an n8n connection + Poll now.

## Remaining
Autonomous high-value work is **complete**. What's left is gated on a decision or a device:
- **Phase 5 reframe** — PLAN is written (`docs/v2/PHASE5-REFRAME-PLAN.md`); awaiting the founder's T1/P1 + positioning picks. Implement only after approval (PLAN_PRICING is sensitive).
- **Deploy** — held by founder ("keep building"). Plan below; needs explicit go + runtime smoke.
- **Phase 4 native binding** — mobile Gemma model load needs a standalone EAS build (scaffold + runbook shipped).
- **Interactive React-Flow editor** — drag/connect on the DAG canvas; a dep decision on top of the shipped read-only graph + step editor.
- **iOS App Store** public submission still parked at PREPARE_FOR_SUBMISSION (TestFlight beta is APPROVED/IN_BETA_TESTING).

## Recommendation
v2 is built and type/unit-verified end-to-end (120 tests + prod build green, 36 web + 4 mobile commits on feat/v2, never deployed). Highest-leverage next step: **a staged web deploy with runtime smoke testing** — validate `ask_user` pause/resume (resume re-runs the step + re-injects the answer; confirm the agent doesn't re-ask), SSE streaming, and the external poller against a live n8n/Make/generic endpoint. Phase 5 (T1/P1) + native offline can follow.
