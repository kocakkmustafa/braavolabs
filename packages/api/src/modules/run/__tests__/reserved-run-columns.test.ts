/**
 * BRA-P0-02c-6 (d) — schema/list completeness. No database needed.
 *
 * `RESERVED_RUN_COLUMNS` (transition.ts) is the hand-written list of `Run`
 * columns only `transitionRun` may write; `extra` rejects exactly those. A new
 * lifecycle column added to the Prisma model but forgotten in the list would be
 * silently writable by any caller through `extra`. This test makes every `Run`
 * column take an explicit side: reserved (lifecycle) or free (data a writer may
 * set through `extra`). A new column fails here until someone decides.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { RESERVED_RUN_COLUMNS } from "../transition";

/** Run columns that are NOT lifecycle: writers pass them in `extra` (or at creation). */
const FREE_RUN_COLUMNS = [
  "trigger",
  "input",
  "output",
  "error",
  "costUsd",
  "budgetUsd",
  "resumeCursor",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt",
  // BRA-P0-08: job budget policy, set once at creation, read by governance.
  "jobBudget",
] as const;

const schemaColumns = Object.keys(Prisma.RunScalarFieldEnum).sort();
const reserved = [...RESERVED_RUN_COLUMNS].sort();
const free = [...FREE_RUN_COLUMNS].sort();

describe("RESERVED_RUN_COLUMNS vs the Run model", () => {
  it("every reserved column exists on the Run model (no stale name)", () => {
    expect(reserved.filter((c) => !schemaColumns.includes(c))).toEqual([]);
  });

  it("every Run column is either reserved or explicitly free (new column forces a decision)", () => {
    const unclassified = schemaColumns.filter((c) => !reserved.includes(c) && !free.includes(c));
    expect(
      unclassified,
      `Run column(s) ${unclassified.join(", ")} are in neither RESERVED_RUN_COLUMNS nor FREE_RUN_COLUMNS: decide whether transitionRun must own them`,
    ).toEqual([]);
  });

  it("no column is both reserved and free, and the free list has no stale name", () => {
    expect(reserved.filter((c) => free.includes(c))).toEqual([]);
    expect(free.filter((c) => !schemaColumns.includes(c))).toEqual([]);
  });

  it("reserved + free is exactly the Run model (birebir)", () => {
    expect([...reserved, ...free].sort()).toEqual(schemaColumns);
  });

  it("the reserved set is the lifecycle set: identity, status/state projection, job-lifecycle columns", () => {
    expect(reserved).toEqual(
      [
        "id", "pipelineId", "status", "state", "resultStatus", "tenantId", "workspaceId",
        "idempotencyKey", "planVersion", "evidenceRef", "retryCount", "heartbeatAt", "deadline",
      ].sort(),
    );
  });
});
