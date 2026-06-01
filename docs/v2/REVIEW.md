# Braavolabs v2 — Review Guide (pre-deploy)

> Review this before we deploy. Everything is on **`feat/v2`** (web) + **`feat/v2`**
> (mobile repo `Apps/Braavo`). Nothing is pushed or deployed yet.
> Verified: **core 29 + api 93 = 122 tests green · all tsc clean · `next build` green.**

## How to review
```bash
# Web (this repo)
git checkout feat/v2
git log --oneline main..feat/v2          # 44 commits
git diff --stat main..feat/v2            # 60 files, +6527 / -768
git diff main..feat/v2 -- packages/api   # backend changes
git diff main..feat/v2 -- packages/core  # plan limits / event contract
pnpm -r --if-present test && pnpm --filter @ai-company-os/ui build   # re-verify

# Mobile (Apps/Braavo)
git -C ../../Apps/Braavo log --oneline main..feat/v2   # 6 commits, 10 files +829/-49
```

## What changed, by area
- **DB (2 migrations — additive, backward-compatible):**
  - `20260601074546_v2_steering_hitl` — `SteeringMessage`, `ApprovalType.INPUT`, `Run.resumeCursor` (mid-run steering + ask_user).
  - `20260601083141_v2_external_monitoring` — `ExternalConnection`, `ExternalRun` (connect & monitor n8n/Make/Zapier).
  - No column drops / type changes on existing tables → safe `migrate deploy`.
- **core:** AG-UI run-event contract + HITL types; **PlanLimits +maxConnectedAutomations/maxSeats/onDeviceOffline** (Phase 5 P1). **PLAN_PRICING prices unchanged.**
- **api:** real-time run SSE (Redis pub/sub, replaces 3s polling); **mid-run STEER** + **ask_user** HITL; external-connections module (poller + n8n/Make/generic adapters + CRUD, +12 tests); connected-automation plan gate; 2 new starter templates.
- **ui:** live run views (SSE) + steer/answer (the moat); `/pipelines/[id]` (List + interactive React-Flow **DAG canvas** + parallel-aware step editor); `/connections`; NL-create modal; **full i18n** (every page + Sidebar, 6 locales); **Phase 5** plan-limit surfacing + **workspace** terminology + positioning reframe.
- **cli:** dep-free `braavo` (login/runs/run/steer/connections).
- **mobile:** run-detail (steer + ask_user answer) + push deep-link; **Phase 4 offline-mode** toggle + on-device seam; workspace terminology.
- **new dep:** `@xyflow/react@12.11` (React Flow, code-split into its own chunk; only loads on the Graph view).

## Spotlight: the v2 moat (worth a close look)
- **Mid-run steering** — `/runs/:id/steer` → `SteeringMessage`; the agent loop drains STEER + INPUT at the top of each turn (`agent/claude.ts`).
- **ask_user** — agent pauses (Approval `INPUT`, run `WAITING_APPROVAL`, push); answering resumes. ⚠️ **Resume re-runs the step from scratch and re-injects the answer** — worth a live smoke test to confirm the agent doesn't re-ask.

## Phase 5 (positioning) — what to sanity-check
- "Company" → **"Workspace"** across all user-facing copy (nav, dashboard, lists, billing, settings) in 6 locales. The **builder wizard keeps "AI company"** as the flagship template; marketing leads with "AI agents & automations workspace."
- Pricing **copy** says workspace; **plan prices are identical** (no Stripe/IAP change). Plan tiers gained automation dimensions (connected automations, seats, on-device) — see `packages/core/src/constants/plans.ts`.

## Risk / rollback
- All commits isolated on `feat/v2`; `main` untouched. Revert = stay on `main`.
- Migrations additive → forward-safe; if needed, the two new tables/columns can be dropped without touching existing data.
- Runtime-unverified (no live env in the build loop): SSE stream, ask_user pause/resume, external poller against a real n8n/Make endpoint, mobile on-device (native binding ships with an EAS build — see `Apps/Braavo/docs/PHASE4-ONDEVICE.md`).

## Deploy plan (when you approve)
GH Actions billing suspended → **manual SSH** to `ubuntu@63.180.74.27`:
1. `git pull` feat/v2 (or merge to main) · `pnpm install` (registers `packages/cli`, `@xyflow/react`)
2. `prisma migrate deploy` (the 2 migrations) · confirm `ENCRYPTION_KEY` set (external creds)
3. `pnpm --filter @ai-company-os/core build` → rebuild + restart `aicos-api` + `aicos-ui` (RAM-tight → sequential)
4. **Runtime smoke:** trigger a run + watch SSE; ask_user pause→answer→resume; post a steering message; add an n8n/generic connection + Poll now.

Ping me with "deploy'a başla" (or merge feedback) and I'll walk each production-mutation step with your OK.
