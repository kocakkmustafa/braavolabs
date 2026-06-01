# Phase 5 — Positioning & Pricing Reframe (PLAN — awaiting approval)

> **Nothing in this doc is implemented.** `PLAN_PRICING` / `PLAN_LIMITS` are
> untouched. This is the proposal you asked for ("tam reframe planı sun");
> pick an option per section and I'll implement only what you approve, all
> through the single source `packages/core/src/constants/plans.ts`.

## 1. Why reframe
v1 sold "an autonomous **AI company** that posts content" — pricing dimensions
reflect that: `maxCompanies`, `channels: [tiktok, linkedin…]`, features like
`hero_template`. v2 generalised the product into an **agent & automation
workspace** (n8n/Make-class): visual builder, mid-run steering, connect &
monitor external automations, BYOK, on-device offline, CLI. The packaging
should price the v2 value, and the narrative should lead with the platform —
with "AI company" kept as the flagship *template*, not the whole product.

## 2. Positioning shift (copy only — no price impact)
- **Headline:** "Autonomous AI company" → **"Your AI agent & automation workspace."** Sub: build, run, and steer agent workflows — or connect the automations you already run — from one place. BYOK, on-device optional.
- **Keep** "AI company" as the marquee onboarding template (the builder wizard) so the magic-moment demo is intact.
- **Surfaces:** marketing hero/features/pricing copy, onboarding, empty states. The dashboards I just localized already read product-neutral ("runs", "pipelines", "connections").

## 3. Terminology: company → workspace (decision needed)
The user-facing noun "Company" reads odd for someone connecting an n8n instance.
Options:
- **(T1) Label-layer rename (recommended).** Keep the Prisma `Company` model, `companyId`, routes, `/companies/*` paths — rename only the **display strings** to "Workspace" via the i18n keys already in place (`app.companyDetail.*`, `app.companyNew.*`, nav, mobile `i18n.ts`). Zero schema/route churn, fully reversible, ships behind the existing locale files. ~1 focused i18n pass × 6 locales.
- **(T2) Full rename** (model, routes, URLs, API). High churn, migration + redirects + mobile + external webhook slugs. Not worth it pre-launch.
- **(T3) Leave as "Company."** Cheapest; keeps the AI-company narrative literal.

## 4. Packaging / pricing (decision needed)
Current (monthly): FREE $0 · CREATOR $19 · PRO $39 · BUSINESS $99 · ENTERPRISE custom. Yearly = ×12×0.8.

Reframe the **dimensions** from content (`maxCompanies`, `channels`) to automation value. Proposed `PlanLimits` shape additions: `maxWorkspaces` (rename of maxCompanies at label layer), `maxRunsPerMonth` (keep), `maxConnectedAutomations` (NEW — external n8n/Make/Zapier connections), `maxSeats` (NEW, from team_seats), `onDeviceOffline` (NEW bool), `byok` (always true).

Two pricing options:

- **(P1) Keep price points, re-scope limits (recommended — lowest risk).** No Stripe price changes, no grandfathering. Just relabel + add the new limit dimensions:
  | Tier | $/mo | Workspaces | Runs/mo | Connected automations | Seats | On-device |
  |------|-----:|-----------:|--------:|----------------------:|------:|:--------:|
  | Free | 0 | 1 | 10 | 1 | 1 | — |
  | Creator | 19 | 5 | 100 | 3 | 1 | ✓ |
  | Pro | 39 | 20 | 500 | 10 | 3 | ✓ |
  | Business | 99 | 100 | 2000 | unlimited | 10 | ✓ |
  | Enterprise | custom | ∞ | ∞ | ∞ | ∞ | ✓ + SSO/SLA |

- **(P2) New automation-tier pricing.** Adjust price points (e.g. add a usage meter for runs beyond cap, or a cheaper "Solo $9" automation-only tier). Higher upside, but needs new Stripe prices + grandfathering existing subscribers + IAP product re-config (Apple/Google). I'll spec the full migration before any change.

## 5. Single-source discipline (applies to whichever option)
- All numbers live ONLY in `plans.ts` (`PLAN_LIMITS`, `PLAN_PRICING`, `PLAN_LABEL`). `plans.test.ts` invariants must still pass (keys aligned across maps, FREE=0, ENTERPRISE=0/custom).
- New limit fields → extend `PlanLimits` in `packages/core/src/types/billing.ts` + enforce in the limit-check middleware + surface on the pricing page (no hardcoded numbers in UI).
- Pricing page + mobile `plans.tsx` read from the constant; i18n keys for any new copy across all 6 locales.

## 6. Stripe / IAP impact
- **P1:** none (prices unchanged) — pure relabel + limit enforcement.
- **P2:** new Stripe Price objects + webhook mapping, Apple/Google IAP product updates, grandfather existing subs (keep old price, show "legacy plan" badge). This is a production + billing mutation → separate approval.

## 7. Recommendation
**T1 + P1**: rename to "Workspace" at the label layer and re-scope the existing
tiers to automation dimensions, **keeping current prices**. Lowest risk, no
billing migration, ships entirely through `plans.ts` + i18n. Revisit P2 (new
tiers / usage metering) after launch with real usage data.

## Decision checklist (reply with your picks)
1. Terminology: **T1 / T2 / T3**
2. Pricing: **P1 / P2** (if P2, I'll spec the Stripe+IAP migration first)
3. Positioning copy reframe (§2): **yes / no**

I implement only the approved items, through the single source, with 6-locale
i18n + tests green, on feat/v2 (no deploy without separate approval).
