import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Locks the RLS wrapper's transaction budget (regression guard for the
 * adversarial HIGH: without an explicit options object every wrapped op
 * inherited Prisma's tight 5s timeout / 2s maxWait, newly 500ing slow queries).
 * We assert the GENEROUS, env-derived budget reaches `base.$transaction`, and
 * that a caller-supplied option still wins.
 *
 * `@prisma/client` and `../config/env` are mocked so this stays a pure unit
 * test (the RLS binding itself is validated end-to-end against real Postgres).
 */

const txSpy = vi.hoisted(() => vi.fn());

vi.mock("../../config/env", () => ({
  env: { DB_TX_TIMEOUT_MS: 30_000, DB_TX_MAXWAIT_MS: 15_000, NODE_ENV: "test" },
}));

vi.mock("@prisma/client", () => {
  // A fake tx client whose ops are inert — the test only inspects the options
  // passed to $transaction, not the query behavior.
  const fakeTx = { $executeRaw: vi.fn().mockResolvedValue(0) };
  class PrismaClient {
    $transaction = (...args: unknown[]) => {
      txSpy(...args);
      const fn = args[0] as (tx: unknown) => unknown;
      return Promise.resolve(fn(fakeTx));
    };
    $extends() {
      return this;
    }
  }
  return { PrismaClient, Prisma: {} };
});

import { tenantTx } from "../db";
import { runWithTenant } from "../tenant-context";

describe("RLS wrapper transaction budget", () => {
  beforeEach(() => txSpy.mockClear());

  it("tenantTx defaults to the generous env budget (not Prisma's 5s/2s)", async () => {
    await runWithTenant("tenant-a", () => tenantTx(async () => "ok"));
    expect(txSpy).toHaveBeenCalledTimes(1);
    const options = txSpy.mock.calls[0][1];
    expect(options).toMatchObject({ timeout: 30_000, maxWait: 15_000 });
  });

  it("a caller-supplied option overrides the default budget", async () => {
    await runWithTenant("tenant-a", () =>
      tenantTx(async () => "ok", { timeout: 90_000 }),
    );
    const options = txSpy.mock.calls[0][1];
    // Caller wins on timeout; the default maxWait is still applied.
    expect(options).toMatchObject({ timeout: 90_000, maxWait: 15_000 });
  });

  it("still wraps (and sets the budget) even with no tenant context", async () => {
    await tenantTx(async () => "ok");
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0][1]).toMatchObject({ timeout: 30_000, maxWait: 15_000 });
  });
});
