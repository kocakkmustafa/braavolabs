/**
 * Multi-key BYOK unit tests (E2/T6 — plan §2.3).
 *
 * UserAIConfig went from one row per tenant (tenantId @unique) to one row
 * per (tenant, provider). These tests pin the two adapted helpers to their
 * new-world contracts WITHOUT building the failover chain (that's T7):
 *
 *   getTenantAIConfig  — resolves the tenant's DEFAULT row: findFirst with
 *                        isDefault-first ordering (createdAt tiebreaker for
 *                        legacy rows), single-config semantics preserved.
 *   saveTenantAIConfig — upserts the (tenant, provider) row, promotes it to
 *                        default, and demotes siblings FIRST in the same
 *                        transaction (one-default-per-tenant invariant,
 *                        matching the partial unique index in migration
 *                        20260702000000_multi_provider_keys_media_assets).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (must be declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-20250514",
  OFFLINE_MODE: false,
}));
vi.mock("../../config/env", () => ({ env: envMock }));

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findFirst: (...a: unknown[]) => db.findFirst(...a),
      updateMany: (...a: unknown[]) => db.updateMany(...a),
      upsert: (...a: unknown[]) => db.upsert(...a),
    },
    // Array-form $transaction — the mocked delegates above run eagerly, so
    // awaiting the array preserves call order for the assertions below.
    $transaction: (ops: unknown[]) => {
      db.transaction(ops);
      return Promise.all(ops as Promise<unknown>[]);
    },
  },
  // RLS-real: saveTenantAIConfig now uses the interactive tenantTx helper
  // (set_config-first, then demote → promote on the same connection). The mock
  // records the transaction marker and runs fn against a tx exposing the
  // userAIConfig delegates, preserving the demote-then-promote call order.
  tenantTx: async (fn: any) => {
    db.transaction();
    return fn({
      userAIConfig: {
        updateMany: (...a: unknown[]) => db.updateMany(...a),
        upsert: (...a: unknown[]) => db.upsert(...a),
      },
    });
  },
}));

const crypto = vi.hoisted(() => ({
  decryptForTenant: vi.fn(),
  encryptForTenant: vi.fn(() => "enc:blob"),
}));
vi.mock("../../lib/encryption", () => ({
  decryptForTenant: (...a: [string, string]) => crypto.decryptForTenant(...a),
  encryptForTenant: (...a: [string, string]) => crypto.encryptForTenant(...a),
}));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getTenantAIConfig,
  saveTenantAIConfig,
  TENANT_CREDENTIAL_MARKER,
} from "../ai-client";

const TENANT = "tenant-multi";

beforeEach(() => {
  db.findFirst.mockReset();
  db.updateMany.mockReset();
  db.upsert.mockReset();
  db.transaction.mockReset();
  crypto.decryptForTenant.mockReset();
  crypto.encryptForTenant.mockClear();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
});

// ── getTenantAIConfig: default-row resolution ──

describe("getTenantAIConfig — multi-row default resolution (T6)", () => {
  it("queries the default row first: where {tenantId}, orderBy isDefault desc + createdAt asc", async () => {
    db.findFirst.mockResolvedValue(null);

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/tenant-owned.*BYOK.*local/i);

    expect(db.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { tenantId: TENANT },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  });

  it("maps the default row to the active config (multi-row tenant)", async () => {
    // Tenant has GROQ (default) + DEEPSEEK (fallback link) rows; the query
    // resolves the default one — the config must mirror exactly that row.
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      encryptedApiKey: "v4:groq-blob",
      baseUrl: null,
      isDefault: true,
      fallbackOrder: null,
      allowSystemFallback: false,
    });
    crypto.decryptForTenant.mockReturnValue("gsk_live_key");

    const config = await getTenantAIConfig(TENANT);

    expect(config).toEqual({
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      apiKey: TENANT_CREDENTIAL_MARKER,
      getApiKey: expect.any(Function),
      baseUrl: undefined,
    });
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();

    expect(config.getApiKey?.()).toBe("gsk_live_key");
    expect(config.getApiKey?.()).toBe("gsk_live_key");
    expect(crypto.decryptForTenant).toHaveBeenCalledExactlyOnceWith("v4:groq-blob", TENANT);
  });

  it("legacy single-row tenant (backfilled isDefault=true) behaves exactly as before the migration", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "OLLAMA",
      model: "gemma3:4b",
      encryptedApiKey: null,
      baseUrl: "http://localhost:11434/v1",
      isDefault: true,
      fallbackOrder: null,
      allowSystemFallback: false,
    });

    const config = await getTenantAIConfig(TENANT);

    expect(config).toEqual({
      provider: "OLLAMA",
      model: "gemma3:4b",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
    });
  });
});

// ── saveTenantAIConfig: demote-then-promote upsert ──

describe("saveTenantAIConfig — per-provider upsert + default promotion (T6)", () => {
  it("runs demote-siblings and composite-key upsert inside one transaction, in that order", async () => {
    db.updateMany.mockResolvedValue({ count: 1 });
    db.upsert.mockResolvedValue({});

    await saveTenantAIConfig(TENANT, "DEEPSEEK", "deepseek-chat", "sk-deepseek-plain");

    // Single (tenant-scoped) transaction wrapping the two operations.
    expect(db.transaction).toHaveBeenCalledOnce();

    // 1) Demote every OTHER default row of this tenant…
    expect(db.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { tenantId: TENANT, NOT: { provider: "DEEPSEEK" }, isDefault: true },
      data: { isDefault: false },
    });

    // 2) …then upsert THIS (tenant, provider) row as the new default.
    expect(db.upsert).toHaveBeenCalledExactlyOnceWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "DEEPSEEK" } },
      update: { model: "deepseek-chat", encryptedApiKey: "enc:blob", baseUrl: null, isDefault: true },
      create: {
        tenantId: TENANT,
        provider: "DEEPSEEK",
        model: "deepseek-chat",
        encryptedApiKey: "enc:blob",
        baseUrl: null,
        isDefault: true,
      },
    });

    // Demote-then-promote ordering — the one-default-per-tenant partial
    // unique index is checked per statement, so promoting first would blow
    // up whenever another default row exists.
    const demoteOrder = db.updateMany.mock.invocationCallOrder[0];
    const upsertOrder = db.upsert.mock.invocationCallOrder[0];
    expect(demoteOrder).toBeLessThan(upsertOrder);

    // The key is encrypted per-tenant (AES-GCM v4 pattern untouched).
    expect(crypto.encryptForTenant).toHaveBeenCalledExactlyOnceWith("sk-deepseek-plain", TENANT);
  });

  it("local provider with an empty key stores encryptedApiKey:null and still becomes the default", async () => {
    db.updateMany.mockResolvedValue({ count: 0 });
    db.upsert.mockResolvedValue({});

    await saveTenantAIConfig(TENANT, "OLLAMA", "gemma3:4b", "", "http://localhost:11434/v1");

    expect(crypto.encryptForTenant).not.toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalledExactlyOnceWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "OLLAMA" } },
      update: {
        model: "gemma3:4b",
        encryptedApiKey: null,
        baseUrl: "http://localhost:11434/v1",
        isDefault: true,
      },
      create: {
        tenantId: TENANT,
        provider: "OLLAMA",
        model: "gemma3:4b",
        encryptedApiKey: null,
        baseUrl: "http://localhost:11434/v1",
        isDefault: true,
      },
    });
  });

  it("saving a second provider does not touch the first row's key material (rows are per-provider now)", async () => {
    db.updateMany.mockResolvedValue({ count: 1 });
    db.upsert.mockResolvedValue({});

    await saveTenantAIConfig(TENANT, "GROQ", "llama-3.3-70b-versatile", "gsk_new");

    // The demote statement only flips isDefault on siblings — it must not
    // carry provider/model/key fields (the old single-row upsert used to
    // OVERWRITE the tenant's only row, losing the previous provider's key).
    const demoteArgs = db.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(demoteArgs.data)).toEqual(["isDefault"]);
  });
});
