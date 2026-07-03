/**
 * E3/T6 — takeover-config resolver + prod baseUrl guard (plan §2.5, B4c).
 * Mocked env + provider-chain, zero network. The REAL resolveTakeoverConfig /
 * assertKeylessLocalBaseUrl run here (the executor test mocks the resolver; this
 * file exercises its internals):
 *
 *   • keyless-local → apiKey "" + baseUrl from the checkpoint's claimBaseUrl,
 *   • model resolved against the TAKEOVER provider (§2.4 — no claude id → Ollama),
 *   • cloud → the tenant's decrypted BYOK link for toProvider,
 *   • a claimed cloud provider no longer configured → hard error (no silent
 *     fallback to another provider / the system wallet),
 *   • a non-claimed ledger (no toProvider) → error,
 *   • prod keyless-local without a baseUrl → REJECTED (B4c); dev / OFFLINE_MODE
 *     / WITH baseUrl / cloud → allowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const envMock = vi.hoisted(() => ({ NODE_ENV: "development" as string, OFFLINE_MODE: false as boolean }));
vi.mock("../../config/env", () => ({ env: envMock }));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const listTenantProviderLinksMock = vi.hoisted(() => vi.fn());
vi.mock("../provider-chain", () => ({
  listTenantProviderLinks: (...a: unknown[]) => listTenantProviderLinksMock(...a),
}));

import { resolveTakeoverConfig, assertKeylessLocalBaseUrl } from "../takeover-config";

/** A CLAIMED ledger (only the fields the resolver reads). */
function claimedLedger(over: Record<string, unknown> = {}) {
  return {
    id: "hl-1",
    tenantId: "tenant-1",
    status: "CLAIMED",
    toProvider: "OLLAMA",
    toModel: "gemma3:4b",
    checkpoint: { messages: [], turn: 1, claimBaseUrl: "http://gpu:11434/v1" },
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.NODE_ENV = "development";
  envMock.OFFLINE_MODE = false;
  listTenantProviderLinksMock.mockResolvedValue([]);
});

// ── keyless-local ──

describe("resolveTakeoverConfig — keyless-local target", () => {
  it("resolves apiKey='' + baseUrl from the checkpoint claimBaseUrl", async () => {
    const cfg = await resolveTakeoverConfig(claimedLedger());
    expect(cfg).toEqual({
      provider: "OLLAMA",
      model: "gemma3:4b",
      apiKey: "",
      baseUrl: "http://gpu:11434/v1",
    });
    // Keyless-local NEVER touches the tenant link decrypt path.
    expect(listTenantProviderLinksMock).not.toHaveBeenCalled();
  });

  it("resolves the model against the takeover provider — a cloud model name never reaches Ollama (§2.4)", async () => {
    const cfg = await resolveTakeoverConfig(claimedLedger({ toModel: "claude-sonnet-4-20250514" }));
    expect(cfg.provider).toBe("OLLAMA");
    expect(cfg.model).not.toBe("claude-sonnet-4-20250514");
  });

  it("REJECTS a prod keyless-local target without a baseUrl (B4c)", async () => {
    envMock.NODE_ENV = "production";
    await expect(
      resolveTakeoverConfig(claimedLedger({ checkpoint: { messages: [], turn: 0 } })),
    ).rejects.toThrow(/base URL/i);
  });

  it("allows a prod keyless-local target WITH a claimBaseUrl", async () => {
    envMock.NODE_ENV = "production";
    const cfg = await resolveTakeoverConfig(claimedLedger());
    expect(cfg.baseUrl).toBe("http://gpu:11434/v1");
  });
});

// ── cloud ──

describe("resolveTakeoverConfig — cloud target", () => {
  it("returns the tenant's decrypted BYOK link for toProvider", async () => {
    listTenantProviderLinksMock.mockResolvedValue([
      { provider: "OPENAI", source: "byok-default", config: { provider: "OPENAI", model: "gpt-4o", apiKey: "sk-plain" } },
    ]);
    const cfg = await resolveTakeoverConfig(claimedLedger({ toProvider: "OPENAI", toModel: "gpt-4o", checkpoint: { messages: [], turn: 1 } }));
    expect(cfg).toMatchObject({ provider: "OPENAI", model: "gpt-4o", apiKey: "sk-plain" });
  });

  it("HARD ERRORS when the claimed cloud provider is no longer configured (no silent fallback)", async () => {
    listTenantProviderLinksMock.mockResolvedValue([
      { provider: "ANTHROPIC", source: "byok-default", config: { provider: "ANTHROPIC", model: "claude", apiKey: "k" } },
    ]);
    await expect(
      resolveTakeoverConfig(claimedLedger({ toProvider: "OPENAI", toModel: "gpt-4o", checkpoint: { messages: [], turn: 1 } })),
    ).rejects.toThrow(/no longer configured/i);
  });
});

describe("resolveTakeoverConfig — guards", () => {
  it("errors on a ledger with no takeover target (not claimed)", async () => {
    await expect(
      resolveTakeoverConfig(claimedLedger({ status: "OPEN", toProvider: null, toModel: null })),
    ).rejects.toThrow(/no takeover target/i);
  });
});

// ── the shared prod baseUrl guard (single source of truth, reused by the router) ──

describe("assertKeylessLocalBaseUrl — prod baseUrl rule (B4c)", () => {
  it("rejects prod keyless-local without a baseUrl", () => {
    envMock.NODE_ENV = "production";
    expect(() => assertKeylessLocalBaseUrl("OLLAMA", undefined)).toThrow(/base URL/i);
    expect(() => assertKeylessLocalBaseUrl("LMSTUDIO", "   ")).toThrow(/base URL/i);
  });

  it("allows prod keyless-local WITH a baseUrl", () => {
    envMock.NODE_ENV = "production";
    expect(() => assertKeylessLocalBaseUrl("OLLAMA", "http://gpu:11434/v1")).not.toThrow();
  });

  it("allows keyless-local without a baseUrl in dev and under OFFLINE_MODE", () => {
    envMock.NODE_ENV = "development";
    expect(() => assertKeylessLocalBaseUrl("OLLAMA", undefined)).not.toThrow();
    envMock.NODE_ENV = "production";
    envMock.OFFLINE_MODE = true;
    expect(() => assertKeylessLocalBaseUrl("OLLAMA", undefined)).not.toThrow();
  });

  it("is a no-op for cloud providers even in prod", () => {
    envMock.NODE_ENV = "production";
    expect(() => assertKeylessLocalBaseUrl("ANTHROPIC", undefined)).not.toThrow();
    expect(() => assertKeylessLocalBaseUrl("OPENAI", undefined)).not.toThrow();
  });
});
