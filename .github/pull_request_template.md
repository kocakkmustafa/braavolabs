## Summary

<!-- One-paragraph description of what this PR does and why. Keep it
     scannable — the title is for the verb, the summary is for the
     reasoning. -->

## Scope

- [ ] Backend (`packages/api`)
- [ ] Frontend (`packages/ui`)
- [ ] Database (`packages/db` — schema or migration touched)
- [ ] Integrations (`packages/integrations`)
- [ ] Memory (`packages/memory`)
- [ ] DevOps / infra (`ENV/`, `.github/`, deploy scripts)
- [ ] Docs only

## Risk

<!-- Pick one. -->

- [ ] Routine — pure refactor / docs / non-prod tooling
- [ ] Standard — feature work touching one module
- [ ] Elevated — touches auth, billing, governance, or schema
- [ ] High — multi-module change OR migration that's hard to roll back

If Elevated or High, attach a rollback plan below.

## Test plan

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean
- [ ] Manually exercised the affected route(s) — describe how:

```
<!-- e.g. POST /auth/login with whitespace email; verified the row
     is canonicalised in the DB -->
```

## Schema / migration checklist

If `packages/db/prisma/schema.prisma` or a migration changed:

- [ ] Migration is **additive** (new columns nullable, new tables only)
- [ ] Pre-deploy compatibility verified — old API code still runs
      against the new schema, AND new code can run against the OLD
      schema until migration ships
- [ ] Backfill plan documented (if a non-null default is used)

## Rollback plan

<!-- Required for Elevated / High risk. How do we undo this if it
     bricks production? "Revert + redeploy" is fine if true; spell out
     the data side if a migration ran. -->

## Related

<!-- Linear / Issue / ADR links. Leave blank if standalone. -->
