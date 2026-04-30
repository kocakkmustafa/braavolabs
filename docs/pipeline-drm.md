# Pipeline export DRM

**Audience:** ops + support engineers, plus the runtime SDK author.
**Status:** v1 (HKDF-SHA256 + AES-256-GCM, JWT HS256, monthly rebind quota).

---

## What it does

Encrypts downloaded pipeline bundles so a user's `.bvbundle` file is
useful only on the machine where it was issued, and only for as long
as the offline license token (`LICENSE_TTL_DAYS`, default 7) is valid.

It is **not** Fort Knox. The threat model is:

| ✓ stops | ✗ does not stop |
|---|---|
| Casual file sharing (Alice emails the bundle to Bob) | Determined attacker on the bound machine |
| Subscription cancellation → continued use | Reverse engineering the runtime SDK |
| Mass automation accounts sharing one license | Cooperating users on similar hardware (`change-machine` quota mitigates this) |

The bar we're trying to raise is "not as easy as a copy-paste." Anything
beyond that is a content-security problem, not a DRM problem.

---

## Wire format

A `.bvbundle` file is JSON:

```json
{
  "license":   "<JWT, HS256, sub=braavolabs.pipeline-license>",
  "iv":        "<base64url, 12 bytes>",
  "tag":       "<base64url, 16 bytes>",
  "ciphertext":"<base64url>",
  "version":   1
}
```

The JWT payload has:

```json
{
  "tenantId": "ten_…",
  "fingerprintHash": "<sha256 hex of the bound fingerprint>",
  "kdfSalt": "<base64, 32 random bytes>",
  "pipelineId": "pip_…",        // omitted for tenant-bundle exports
  "iat": 1735689600,
  "exp": 1736294400,
  "sub": "braavolabs.pipeline-license"
}
```

`kdfSalt` is unique per encryption call. The runtime recombines it with
the local raw fingerprint to derive the AES key:

```
aes_key = HKDF_SHA256(
    ikm  = raw_fingerprint_bytes,
    salt = kdfSalt,
    info = "braavolabs:pipeline-export:v1",
    L    = 32
)
```

`info` is versioned (`v1`) so a future protocol change can ship without
silently breaking files already in the wild.

---

## API surface

All under `/api/v1/license/*`, all behind `authMiddleware`.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/license/download` | `{ fingerprint, pipelineId? }` | `EncryptedBundle` JSON |
| `POST` | `/license/verify` | `{ license, fingerprint }` | `{ ok, expiresAt }` or `{ ok: false, reason, message }` |
| `POST` | `/license/change-machine` | `{ fingerprint }` | `{ ok, remainingChanges, message }` |
| `GET` | `/license/status` | — | dashboard summary |

Status codes worth knowing:

- **409 `different_machine`** — `/download` saw a fingerprint that
  doesn't match the current binding. Tell the user to use change-machine.
- **429 `quota_exhausted`** — change-machine over the monthly cap.
- **503** — `LICENSE_JWT_SECRET` is unset. DRM is intentionally off.

---

## Environment variables

```bash
# REQUIRED to enable DRM. Generate with: openssl rand -hex 32
LICENSE_JWT_SECRET=

# Token TTL in days. 7 is a sane default — long enough for flights /
# offline work, short enough that a leaked secret has bounded blast radius.
LICENSE_TTL_DAYS=7

# Per-month allowance of /change-machine calls. Default 1 = "one swap
# per calendar month (UTC)". Bump to 3 for high-end plans if you want
# travelling teams to have more flex.
LICENSE_MACHINE_CHANGES_PER_MONTH=1
```

---

## Operations

### Rotating `LICENSE_JWT_SECRET`

This invalidates **every** outstanding license token in the wild. Plan
for it: most users won't notice (they re-verify on the next 7-day cycle
anyway), but anyone running offline at the moment of rotation will see
a "license expired" error from the runtime.

Steps:

1. Schedule the rotation during a low-traffic window (Sunday morning UTC).
2. Generate the new key: `openssl rand -hex 32`
3. Update `.env` on the production host:
   ```bash
   sudo nano /opt/braavolabs/app/.env
   # Replace LICENSE_JWT_SECRET=…
   ```
4. Restart the API container:
   ```bash
   sudo docker compose --env-file /opt/braavolabs/app/.env \
     -f /opt/braavolabs/app/ENV/compose.prod.yaml \
     up -d --force-recreate --no-deps api
   ```
5. Notify support — incoming "my pipeline stopped working offline"
   tickets in the next 7 days are this rotation, not a real bug.

### Resetting a tenant's machine binding (support flow)

A user lost access to their bound machine and is past their monthly
`/change-machine` allowance. Manual override:

```sql
-- Connect to prod DB:
UPDATE pipeline_licenses
SET device_fingerprint = NULL,
    last_bound_at      = NULL,
    monthly_machine_changes_used = 0
WHERE tenant_id = '<tenantId>';
```

The next `/download` call will re-bind to whatever fingerprint they
present. Audit-log this in `activity_log`:

```sql
INSERT INTO activity_log (id, tenant_id, actor, action, resource, resource_id, details)
VALUES (
  gen_random_uuid()::text,
  '<tenantId>',
  'support:<your-handle>',
  'license.support_reset',
  'pipeline_license',
  '<tenantId>',
  '{"reason": "lost machine, manual override", "ticket": "<id>"}'::jsonb
);
```

### Disabling DRM on a self-hosted deployment

Self-hosted operators who don't want DRM (e.g. fully internal use):

```bash
# In /opt/braavolabs/app/.env:
LICENSE_JWT_SECRET=
```

The `/license/*` endpoints return 503 with a message clearly stating
DRM is disabled. The dashboard hides the "encrypted download" button
when `/license/status` returns `enabled: false`.

---

## Failure modes worth knowing

- **Clock skew.** JWT `exp` is enforced strictly; a machine clock that's
  >1 day fast will fail-verify. The runtime SDK checks `Date.now()`
  against the local clock first and falls back to the server's
  `/license/verify` (which uses server time) so users get a better
  error than "expired" when the real cause is "your laptop thinks it's
  2030."

- **Fingerprint volatility.** Some OSes generate different fingerprints
  after a kernel upgrade or disk re-image. We accept this as the cost
  of binding — affected users hit `/change-machine`, costing one of
  their monthly slots. Repeat offenders should be moved to a higher
  monthly cap (per-tenant override, not yet UI-driven; edit
  `pipeline_licenses` directly with SQL).

- **Lost `LICENSE_JWT_SECRET`.** All outstanding licenses become
  unverifiable. The DB still works; users can re-download their
  bundles. There is no key recovery mechanism — generate a new secret
  and follow the rotation runbook.

---

## Future work

- Per-tier monthly caps (Free=0 swaps, Creator=1, Pro=3, Business=10).
- Webhook on `/license/change-machine` for fraud alerts (5+ swaps
  across distinct geos in 24h).
- Dual-binding (laptop + desktop) for Pro+ tiers. Schema is already
  per-tenant; the upgrade is making `device_fingerprint` an array.
- Soft expiry: continue running for an extra 24h with a warning banner
  when `/verify` fails network-side, so flaky internet doesn't lock
  users out mid-run.
