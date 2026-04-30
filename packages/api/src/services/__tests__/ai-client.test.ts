/**
 * AI client provider catalog — pure data integrity tests.
 *
 * No network calls, no Prisma; just asserts that the provider tables
 * stay internally consistent (every key has a default model, every
 * default model is present in the per-provider list, every cloud
 * provider has a base URL etc.). Catches regressions when adding a new
 * provider — easy to forget one of the 4 maps.
 */
import { describe, it, expect } from "vitest";
import {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  PROVIDER_BASE_URLS,
  PROVIDER_INFO,
  LOCAL_PROVIDERS,
  type AIProviderType,
} from "../ai-client";

const ALL_PROVIDERS: AIProviderType[] = [
  "ANTHROPIC",
  "OPENAI",
  "GOOGLE",
  "MISTRAL",
  "GROQ",
  "OPENROUTER",
  "DEEPSEEK",
  "KIMI",
  "QWEN",
  "OLLAMA",
  "LMSTUDIO",
  "CUSTOM",
];

describe("Provider catalog consistency", () => {
  it("every provider has a default model", () => {
    for (const p of ALL_PROVIDERS) {
      expect(PROVIDER_DEFAULT_MODELS[p], `default missing for ${p}`).toBeTruthy();
    }
  });

  it("every provider has a model list (CUSTOM may be empty)", () => {
    for (const p of ALL_PROVIDERS) {
      expect(PROVIDER_MODELS[p], `model list missing for ${p}`).toBeDefined();
      if (p !== "CUSTOM") {
        expect(PROVIDER_MODELS[p].length, `model list empty for ${p}`).toBeGreaterThan(0);
      }
    }
  });

  it("default model is in the provider's model list (except CUSTOM, which is open-ended)", () => {
    for (const p of ALL_PROVIDERS) {
      if (p === "CUSTOM") continue;
      const def = PROVIDER_DEFAULT_MODELS[p];
      expect(
        PROVIDER_MODELS[p].includes(def),
        `default "${def}" not in PROVIDER_MODELS[${p}]`,
      ).toBe(true);
    }
  });

  it("every non-Anthropic / non-Google provider has a base URL", () => {
    const cloudOpenAICompat: Array<keyof typeof PROVIDER_BASE_URLS> = [
      "OPENAI",
      "MISTRAL",
      "GROQ",
      "OPENROUTER",
      "DEEPSEEK",
      "KIMI",
      "QWEN",
    ];
    for (const p of cloudOpenAICompat) {
      expect(PROVIDER_BASE_URLS[p], `base URL missing for ${p}`).toMatch(/^https:\/\//);
    }
  });

  it("local provider base URLs default to localhost", () => {
    expect(PROVIDER_BASE_URLS.OLLAMA).toMatch(/localhost/);
    expect(PROVIDER_BASE_URLS.LMSTUDIO).toMatch(/localhost/);
  });

  it("PROVIDER_INFO has a label, cost, privacy, setupHint for every provider", () => {
    for (const p of ALL_PROVIDERS) {
      const info = PROVIDER_INFO[p];
      expect(info, `info missing for ${p}`).toBeDefined();
      expect(info.label.length).toBeGreaterThan(0);
      expect(["free", "byok-cloud", "byok-local"]).toContain(info.cost);
      expect(["cloud", "local"]).toContain(info.privacy);
      expect(info.setupHint.length).toBeGreaterThan(0);
    }
  });

  it("LOCAL_PROVIDERS set contains exactly OLLAMA + LMSTUDIO + CUSTOM", () => {
    expect(LOCAL_PROVIDERS.has("OLLAMA")).toBe(true);
    expect(LOCAL_PROVIDERS.has("LMSTUDIO")).toBe(true);
    expect(LOCAL_PROVIDERS.has("CUSTOM")).toBe(true);
    expect(LOCAL_PROVIDERS.has("ANTHROPIC")).toBe(false);
    expect(LOCAL_PROVIDERS.has("OPENAI")).toBe(false);
    expect(LOCAL_PROVIDERS.size).toBe(3);
  });

  it("Schema covers exactly 12 providers (3 cloud-major + 3 cloud-aux + 3 cloud-new + 3 local)", () => {
    expect(Object.keys(PROVIDER_DEFAULT_MODELS).length).toBe(12);
    expect(Object.keys(PROVIDER_INFO).length).toBe(12);
  });
});
