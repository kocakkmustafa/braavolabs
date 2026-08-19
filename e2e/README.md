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

`playwright.config.ts` boots both servers itself (API on 4310, UI on 4311), so
the test command is self-contained — there is no manual step to forget and then
misdiagnose.

## Coverage

| Spec | Journey |
|---|---|
| `smoke.spec.ts` | harness liveness — tells "app broken" apart from "harness never started" |
| `onboarding-first-run.spec.ts` | register → session → first company (the activation gate's journey) |
| `approval.spec.ts` | approvals queue, auth requirement, cross-tenant decision refusal |
| `billing.spec.ts` | pricing page, per-route auth, tenant-scoped state, IAP webhook reachability |

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
