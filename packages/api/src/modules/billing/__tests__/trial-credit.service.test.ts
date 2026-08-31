import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  FORGE_TRIAL_CREDIT_USD_CAP: 10,
  CEREBRAS_API_KEY: "system-cerebras",
  GROQ_API_KEY: "system-groq",
  ZHIPU_API_KEY: "system-zhipu",
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

const db = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn() }));
vi.mock("../../../lib/db", () => ({
  prisma: { usageMeter: { findUnique: vi.fn() } },
  tenantTx: (fn: (tx: unknown) => unknown) => fn({
    $queryRaw: (...args: unknown[]) => db.queryRaw(...args),
    $executeRaw: (...args: unknown[]) => db.executeRaw(...args),
  }),
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: (...args: unknown[]) => chatCompletionMock(...args),
}));

import {
  NoSystemHeldKeyError,
  getForgeTrialCreditStatus,
  hasSystemHeldKey,
  refundTrialCredit,
  reserveTrialCredit,
  runForgeTrialCompletion,
  settleTrialCredit,
  trialCreditEnabled,
} from "../trial-credit.service";

beforeEach(() => vi.clearAllMocks());

describe("retired hosted trial credit", () => {
  it.each(["CEREBRAS", "GROQ", "ZHIPU"] as const)(
    "keeps %s unreachable even when a system key and positive cap are present",
    async (provider) => {
      expect(hasSystemHeldKey(provider)).toBe(false);
      expect(trialCreditEnabled()).toBe(false);
      await expect(
        runForgeTrialCompletion("tenant", provider, "model", "system", [{ role: "user", content: "hello" }]),
      ).rejects.toBeInstanceOf(NoSystemHeldKeyError);
      expect(chatCompletionMock).not.toHaveBeenCalled();
      expect(db.queryRaw).not.toHaveBeenCalled();
      expect(db.executeRaw).not.toHaveBeenCalled();
    },
  );

  it("cannot reserve, settle, or refund a system-funded bucket", async () => {
    await expect(reserveTrialCredit("tenant")).resolves.toBeNull();
    await expect(settleTrialCredit("tenant", 0.02, 0.01)).resolves.toBeUndefined();
    await expect(refundTrialCredit("tenant", 0.02)).resolves.toBeUndefined();
    expect(db.queryRaw).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it("reports an immutable disabled status", async () => {
    await expect(getForgeTrialCreditStatus("tenant")).resolves.toEqual({
      enabled: false, capUsd: 0, spentUsd: 0, remainingUsd: 0, exhausted: false,
    });
  });
});
