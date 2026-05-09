# Security Policy

## Reporting a vulnerability

If you've discovered a security issue, **please don't open a public
issue or PR**. Instead, email **security@braavolabs.com** with:

1. A short summary of the issue.
2. A reproduction (URL, repro steps, or PoC code).
3. The impact you believe it has — what an attacker could do.

We aim to acknowledge within 48 hours, ship a triage assessment within
5 business days, and credit you in the patch's release notes (or
omit your name on request).

We do not currently run a paid bug-bounty programme, but a high-impact
report that lets us close a real risk lands you on our public
"thank-you wall" at braavolabs.com/security.

## Scope

In scope:

- The Braavolabs web app (braavolabs.com) and API (api.braavolabs.com)
- The mobile app (Braavolabs iOS / Android) and its backend bridges
  (`/devices/*`, `/billing/iap/*`)
- Self-hosted Docker bundle distributed via this repo

Out of scope:

- Findings against unmaintained branches (anything not on `main`)
- Theoretical issues without a concrete exploitation path
- Volumetric DDoS / brute-force without bypassing rate limits
- Issues in third-party services we depend on (Stripe, SendGrid,
  Cloudflare) — please report those upstream

## Threat model

We treat the following as critical:

- **Cross-tenant data access** — every Prisma read/write must be
  tenant-scoped. Findings here are paged immediately.
- **Privilege escalation** — non-OWNER role gaining OWNER capabilities,
  or any role bypassing the spend-approval gate.
- **Credential leakage** — encrypted-at-rest LLM / integration keys
  surfacing in logs, responses, or backups.
- **RCE / SSRF** — anything that lets an external request reach
  internal IPs or run server-side code.

## Disclosure

We follow a coordinated disclosure model: by default we'll publish the
fix + an advisory 30 days after the patch lands, or sooner if the
vulnerability is already public. We'll discuss the timeline with the
reporter when the issue is acknowledged.
