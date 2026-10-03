# Tenant RLS Stage 2 — prepared, not applied

Status: **EXTERNAL_GATE**
Manual gate: **MANUAL-BRAAVO-SECURITY-ROOTS / RLS_STAGE2**

This runbook prepares the non-owner runtime role, fail-closed tenant context,
canary and rollback contract. It does not prove that production uses the role.
Local fixtures, `SET ROLE`, compose parsing and unit tests **must not be treated
as production proof**.

## Required authority and evidence

Do not begin Stage 2 until the founder has supplied all of the following:

1. A timestamped production backup plus a successful restore rehearsal artefact.
2. Secret-manager access for a new, unique `aicos_app` password; never place it
   in this repository, a shell argument, a log or an evidence bundle.
3. The currently deployed API image SHA and the previous known-good image SHA.
4. A dedicated canary window, two founder-approved canary tenants and authority
   to restart only the API service.
5. Separate owner/migration and non-owner/runtime connection strings. The owner
   URL remains `MIGRATE_DATABASE_URL`; only the runtime URL may become
   `RUNTIME_DATABASE_URL`.

Any missing item keeps this task at `EXTERNAL_GATE`.

## Create the non-owner role (manual production step)

Connect with the schema-owner migration identity. Use `\password` so the new
secret is prompted rather than written into shell history:

```sql
\set ON_ERROR_STOP on
CREATE ROLE aicos_app
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;
\password aicos_app

GRANT CONNECT ON DATABASE aicos_prod TO aicos_app;
GRANT USAGE ON SCHEMA public TO aicos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aicos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aicos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE aicos IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aicos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aicos IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aicos_app;
```

The runtime role must not own the database, schema or tenant tables. It receives
data-plane DML only; schema changes continue through the owner connection.

## Fail-closed preflight

Record the result of each query without recording a password or DSN:

```sql
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolbypassrls
FROM pg_roles WHERE rolname = 'aicos_app';

SELECT datname, pg_get_userbyid(datdba) AS owner
FROM pg_database WHERE datname = 'aicos_prod';

SELECT
  n.nspname AS schema_name,
  pg_get_userbyid(n.nspowner) AS schema_owner,
  n.nspacl AS schema_acl,
  COALESCE((
    SELECT bool_or(
      acl.grantee = 0
      AND acl.privilege_type = 'CREATE'
    )
    FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
  ), false) AS public_can_create,
  has_schema_privilege('aicos_app', 'public', 'CREATE') AS aicos_app_can_create
FROM pg_namespace AS n
WHERE n.nspname = 'public';

SELECT n.nspname AS schemaname, c.relname AS tablename,
  pg_get_userbyid(c.relowner) AS tableowner,
  c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
```

Record the `schema_owner`, `schema_acl`, `public_can_create` and
`aicos_app_can_create` fields as one privilege snapshot before changing any
grant. The safe owner contract is: `public` belongs to the founder-approved
migration identity, or to `pg_database_owner` only when the database-owner
query above proves that identity is the approved migration owner. The runtime
role `aicos_app` must own neither the database nor the schema.

Acceptance requires `rolsuper = false`, `rolbypassrls = false`,
`aicos_app_can_create = false`, and no tenant table owned by `aicos_app`.
Confirm every tenant table has RLS enabled and the expected policy set. Do not
grant `BYPASSRLS`, ownership, `CREATE`, `ALTER` or `DROP` to make a canary
green.

If either effective CREATE check is true, only the founder-gated production
operator may run these exact hardening statements after retaining the recorded
privilege snapshot:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM aicos_app;
```

This AI-local task does not execute either statement and does not claim the
production result. Re-run the owner/ACL/privilege query and require both
`public_can_create = false` and `aicos_app_can_create = false` before canary
traffic.

The API container must receive both:

```text
TENANT_CONTEXT_FAIL_CLOSED=true
RUNTIME_DATABASE_URL=<secret-manager reference for aicos_app>
```

`ENV/compose.prod.yaml` deliberately keeps the owner URL as its non-Stage-2
fallback. Merely seeing the variables in parsed compose output is not evidence
that the running container received them. Capture redacted runtime env presence,
the authenticated database role (`SELECT current_user`) and role attributes
from the canary instance.

## Canary matrix

Run the canary first against a single isolated API instance. Traffic must not be
shifted until all controls pass:

1. With no tenant context, an authenticated tenant-scoped Prisma operation
   fails with `TenantContextError` before issuing provider or database work.
2. Tenant A can perform its own CRUD, CRM search, run read, audit read and
   billing read; Tenant B can perform the same control operations.
3. A→B and B→A read, update and delete attempts return the same non-success
   shape as an unknown resource and leak no tenant, user, company, run, contact,
   audit or billing identifier.
4. Searching Tenant A's company for Tenant B's unique marker returns zero rows,
   and vice versa; each tenant's own marker remains visible as a non-vacuous
   control.
5. A forged `tenantId` in query/body is ignored or rejected. The persisted JWT
   tenant remains authoritative.
6. Background/system paths explicitly declared with `runWithoutTenant` retain
   their documented behavior. No shared/system-funded inference is invoked.
7. Compare entitlement, audit and row counts before/after. Failed cross-tenant
   attempts must have zero data effect.

The local `cross-tenant.test.ts` fixture is rehearsal evidence only. Production
acceptance requires the same matrix through the deployed canary while connected
as `aicos_app`, plus `current_user = aicos_app`, `rolsuper = false` and
`rolbypassrls = false` receipts.

## Promotion stop conditions

Stop and rollback on any 5xx increase, missing tenant context, cross-tenant
identifier, non-idempotent data effect, unexpected background-job failure,
connection-pool regression or role/owner mismatch. Never loosen an RLS policy or
grant ownership during incident pressure.

## Rollback (manual production step)

1. Remove canary traffic.
2. Restore the previously recorded owner runtime URL and previous API image SHA;
   restart only the API service under the approved window.
3. Keep `TENANT_CONTEXT_FAIL_CLOSED=true` when possible. If an unmarked legacy
   path prevents service recovery, the founder may temporarily set it to
   `false` only after returning to the owner connection; record the exception
   and affected path.
4. Compare the current schema owner and ACL to the recorded privilege snapshot.
   Do not blindly `GRANT CREATE` to `PUBLIC` or `aicos_app`. Restore a CREATE
   grant only when the exact preflight ACL proves that same grantee previously
   held it, the founder explicitly approves restoring it, and the rollback
   record names the grantee and original grantor. Otherwise leave CREATE
   revoked. This avoids manufacturing a broader privilege state than the one
   that existed before the canary.
5. Re-run own-tenant controls and compare row counts/audit integrity.
6. Preserve the `aicos_app` role, grants, policies and all ledger/data rows for
   forensic review. Do not drop roles, policies, migrations or data as rollback.
7. Use the backup restore only for proven data corruption and only with separate
   founder authorization.

The code/config rollback is the eventual task commit revert. No production
rollback command is executed by this AI-local task.

## Evidence packet

Retain backup and restore IDs, image SHAs, redacted DSN identities, role query
output, parsed compose output, canary HTTP matrix, before/after row counts,
process/log excerpts with secret scan, UTC start/end, operator identity, stop or
promotion decision, and rollback rehearsal result. Signed production evidence
is required before the roadmap state can leave `EXTERNAL_GATE`.
