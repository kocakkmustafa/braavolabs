# Braavolabs v2 — Build Status & Deploy Handoff

> 2026-06-01 · branch **`feat/v2`** (web) + **`feat/v2`** (mobile repo `Apps/Braavo`)
> **NOT pushed, NOT deployed** — awaiting founder review + deploy approval.
> Verification to date is **tsc/type-check + unit tests only** (108 green). No runtime/device test yet.

## What shipped (by vision pillar)

| # | Pillar | Status | Where |
|---|--------|--------|-------|
| 1 | Visual/editable builder + per-agent control + live logs | ✅ core | `/pipelines/[id]` (read-only topology **+ full step editor**: add/reorder/remove + agent picker, editable settings), live `/runs/[id]` + company run view via real-time SSE, RunStepHeatmap. (Drag-drop canvas = deferred nicety.) |
| 2 | **HITL: mid-run steer + agent↔human Q&A** (the moat) | ✅ end-to-end | `SteeringMessage` model; agent-loop drains STEER+INPUT each turn (`claude.ts`); `ask_user` tool → INPUT approval + WAITING_APPROVAL + push; `POST /runs/:id/steer`; answer via `decideApproval(note)`; web steer box + answer card; mobile steer + answer. |
| 3 | BYOK + model/provider choice | ✅ (pre-existing) | 12-provider router `services/ai-client.ts`; settings UI. |
| 4 | Connect & monitor external automations | ✅ end-to-end | `ExternalConnection`/`ExternalRun` schema + n8n poller (`modules/external`) + CRUD API + `/connections` web UI. (Make/Zapier adapters = follow-on; n8n live.) |
| 5 | Mobile pocket control | ✅ core | `Apps/Braavo` run-detail screen (live polling, steer, ask_user answer), trigger→detail + push deep-link. |
| 6 | Fully-offline on-device Gemma | ⚠️ partial | Desktop offline via Ollama/LM Studio (pre-existing) + machine-bound encrypted bundle (export/license). **Mobile on-device Gemma is NATIVE work — not built** (needs react-native-ai/LiteRT-LM + a device/EAS build; can't verify in this loop). |
| 7 | CLI | ✅ | dep-free `packages/cli` (`braavo login/runs/run/steer/connections`). |

**Also:** real-time SSE (replaced 3s polling), AG-UI event contract (`@ai-company-os/core`), NL→pipeline creation surfaced in UI, sidebar Connections link.

## Commits (feat/v2)
- **web (19):** master plan → `/pipelines/[id]` → AG-UI contract → SSE backend → `/runs/[id]` live → company run live → HITL schema → STEER drain+endpoint → ask_user → steer UI → answer UI → mobile api (skip) → NL-create modal → external schema → external poller → external CRUD+wiring → `/connections` UI → sidebar+pipeline settings → step editor → CLI.
- **mobile (3):** RunDetail api client → run-detail screen → nav (trigger + push deep-link).

## Verification
- `core` 27/27 + `api` 81/81 vitest = **108 pass** after all engine changes (no regressions).
- All packages `tsc --noEmit` clean (core/api/ui/cli). Mobile tsc clean modulo a pre-existing duplicate-`@types` (`TS2688 "node 2"`) env artifact — filter with `grep -vE TS2688`.
- **Not yet done:** `next build` (UI prod bundle), runtime smoke, mobile device/EAS build.

## Deploy plan (needs approval — production mutation)
GitHub Actions is billing-suspended → **manual SSH** to `ubuntu@63.180.74.27` (see `Apps/Braavo/MANUAL-DEPLOY.md` flow). Steps:
1. **Review** feat/v2 diff; merge to `main` (or deploy the branch).
2. `pnpm install` (registers `packages/cli`; no new deps).
3. **Migrations (2):** `20260601074546_v2_steering_hitl`, `20260601083141_v2_external_monitoring` — both additive/backward-compatible. Apply via `prisma migrate deploy` on the prod DB.
4. Confirm `ENCRYPTION_KEY` set (external-connection creds use it).
5. Rebuild + restart `aicos-api` + `aicos-ui` (Lightsail manual build; RAM-tight → sequential).
6. **Runtime smoke:** trigger a run + watch SSE; `ask_user` pause→answer→resume; post a steering message; add an n8n connection + Poll now.

## Remaining (post-this-arc)
- **i18n sweep** (in progress): localize hardcoded-EN pages (`companies/[id]/runs/[runId]`, `runs/[id]`, `pipelines/[id]`, `connections`) to 6 locales.
- **Phase 4:** mobile on-device Gemma (native).
- **Phase 5:** pricing/positioning reframe (company→workspace; keep `PLAN_PRICING` single source), drag-drop DAG canvas, parallel-aware step editor, Make/Zapier poll adapters.
- **iOS App Store** public submission still parked at PREPARE_FOR_SUBMISSION (separate from TestFlight beta, which is APPROVED/IN_BETA_TESTING).

## Recommendation
The v2 differentiators (mid-run steering moat, mobile pocket control, connect-and-watch, CLI) are built and type/unit-verified. The highest-leverage next step is a **founder review + a staged web deploy with runtime smoke testing** — the moat's `ask_user` pause/resume in particular benefits from a live test (the resume currently re-runs the step from scratch and re-injects the answer; validate the agent doesn't re-ask). i18n + native offline can follow.
