# Changelog

All notable changes to the Braavolabs monorepo (api + ui + shared libraries) are
documented here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
since `main` deploys continuously to production, entries are grouped by date
rather than by version tag. PR numbers refer to `kocakkmustafa/braavolabs`.

## [Unreleased]

- _(nothing yet)_

## 2026-07-18

### Fixed
- **Logout revokes even with an expired access token** (R5, #53) — `/auth/logout`
  is now auth-optional with a refresh-token body/cookie fallback, uniform 200
  no-op responses (no token-validity oracle), a refresh-typ guard on the bearer
  slot, and a CSRF gate on cookie-sourced tokens.

## 2026-07-17

### Added
- Debate round + cascade confidence self-report for multi-model ask-all (#51).
- Cookie-mode UI support — `NEXT_PUBLIC_AUTH_COOKIE_MODE` aware client (#48).
- RLS STAGE 2 groundwork — `aicos_app` runtime role support behind
  `RUNTIME_DATABASE_URL` (code shipped; activation is a gated ops step) (#47).

### Fixed
- Web sign-out now revokes the refresh token server-side (#52).
- Two money-path correctness bugs found by the ecosystem audit (#50).

### Changed
- CLI and Desktop extracted to standalone repos (`braavolabs-cli`,
  `braavolabs-desktop`); the monorepo now holds api + ui + libraries (#49).

## 2026-07-15 → 2026-07-16

### Added
- Forge media backend — image/voice orchestration endpoints (#41).
- Forge CLI P4 + Desktop feature waves (pre-extraction) (#38–#40).
- Native OS approval dialog for desktop side effects (S-012) (#45).
- OS-keychain secret storage for desktop (S-010) (#44).

### Fixed
- Sentry/OTel v10 upgrade closing the transitive CVE chain (S-003) (#42, #36).
- `@babel/core` CVE bump (#46) and Cargo.lock pinning for the desktop crate
  (S-011) (#43).
- Pipeline hardening fixes (#37).

## 2026-07-02 → 2026-07-11

### Added
- Forge P1: providers 12→14 (Cerebras + GLM), memory-vault moat, cost-aware
  routing, `GET /billing/savings`, cascade orchestrator (`POST /research/cascade`),
  cost preview, and the `/forge` cinematic landing (#34).
- Forge P2 follow-up wave (#35).
- E2 provider orchestration, E3 handoff, E4 scheduler, E5 connector SDK
  (#28–#33).
- External control plane (#26).

### Fixed
- Health-debt sweep 2026-07-02 (#27); handoff context summary fix (#30).

## 2026-06

### Added
- v2 platform wave (#22) and the Forge obsidian/steel/arc-blue redesign (#23).

### Security
- Competitive hardening (#24) and the multi-tenancy / webhook hardening audit
  wave — tenant isolation verified airtight (#25).

## 2026-03 → 2026-04 (V1)

- Initial platform: orchestrator API, company builder, pipeline runner, memory
  engine, Docker Compose deploy, 20-table schema (Faz 0–2).
- V1 production readiness: security hardening, DB index migration, six feature
  integrations.
