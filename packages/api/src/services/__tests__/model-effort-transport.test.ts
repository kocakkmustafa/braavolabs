/** Real adapter serialization, entirely mocked transport/SDK and synthetic keys. */
import {beforeEach, describe, expect, it, vi} from "vitest";
const m = vi.hoisted(() => ({fetch: vi.fn(), sdk: vi.fn(), key: vi.fn()}));
vi.mock("@anthropic-ai/sdk", () => ({default: class {messages = {create: m.sdk};}}));
vi.mock("../../config/env", () => ({env: {OFFLINE_MODE: false}}));
vi.mock("../../lib/db", () => ({prisma: {}}));
vi.mock("../../lib/encryption", () => ({decryptForTenant: vi.fn(), encryptForTenant: vi.fn()}));
vi.mock("../../lib/logger", () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../../lib/ssrf", () => ({safeExternalFetch: m.fetch, SsrfError: class extends Error {}}));
import {chatCompletion, type AIClientConfig} from "../ai-client";
import {classifyProviderError, isFailoverEligible} from "../provider-chain";

const config: AIClientConfig = {provider: "CEREBRAS", model: "gpt-oss-120b", apiKey: "synthetic-marker", getApiKey: m.key};
const messages = [{role: "user" as const, content: "synthetic question"}];
beforeEach(() => {
  vi.clearAllMocks(); m.key.mockReturnValue("synthetic-key-never-sent");
  m.fetch.mockImplementation(async (_url, _init, policy) => {
    const prepared = policy.prepareRequest();
    expect(prepared.headers.Authorization).toBe("Bearer synthetic-key-never-sent");
    return new Response(JSON.stringify({choices: [{message: {content: "answer"}, finish_reason: "stop"}], usage: {prompt_tokens: 2, completion_tokens: 3}}));
  });
});

describe("exact effort transport capability", () => {
  it.each(["low", "medium", "high"] as const)("serializes %s on the verified exact endpoint/model", async reasoningEffort => {
    await chatCompletion(config, "system", messages, 1024, {reasoningEffort} as any);
    expect(m.fetch).toHaveBeenCalledOnce();
    const [url, init] = m.fetch.mock.calls[0];
    expect(url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(JSON.parse(init.body)).toEqual({model: "gpt-oss-120b", max_tokens: 1024, reasoning_effort: reasoningEffort,
      messages: [{role: "system", content: "system"}, ...messages]});
    expect(m.key).toHaveBeenCalledOnce(); expect(m.sdk).not.toHaveBeenCalled();
  });
  it("keeps the exact no-effort body and provider default", async () => {
    await chatCompletion(config, "system", messages, 512);
    expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual({model: "gpt-oss-120b", max_tokens: 512,
      messages: [{role: "system", content: "system"}, ...messages]});
  });
  it("accepts an explicit built-in URL with the adapter's trailing slash convention", async () => {
    await chatCompletion({...config, baseUrl: " https://api.cerebras.ai/v1/ "}, "system", messages, 512, {reasoningEffort: "high"} as any);
    expect(m.fetch.mock.calls[0][0]).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(JSON.parse(m.fetch.mock.calls[0][1].body).reasoning_effort).toBe("high");
  });
  const unsupported = [
    ...["ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER", "DEEPSEEK", "KIMI", "QWEN", "ZHIPU", "OLLAMA", "LMSTUDIO", "CUSTOM"].map(provider => ({provider})),
    {model: "glm-4.7"}, {model: "gpt-oss-120b-preview"},
    {baseUrl: "https://proxy.example.invalid/v1"}, {baseUrl: "https://api.cerebras.ai/v1?ignored=true"},
    {baseUrl: "https://api.cerebras.ai/v1/other"}, {baseUrl: "http://api.cerebras.ai/v1"},
  ];
  it.each(unsupported)("rejects an unverified combination %j before credentials/transport with a fatal error", async override => {
    const err = await chatCompletion({...config, ...override} as AIClientConfig, "system", messages, 512, {reasoningEffort: "high"} as any).then(() => undefined, e => e);
    expect(err).toBeInstanceOf(Error); expect(err).toMatchObject({name: "UnsupportedReasoningEffortError", status: 400});
    expect(classifyProviderError(err)).toBe("FATAL"); expect(isFailoverEligible(classifyProviderError(err))).toBe(false);
    expect(m.key).not.toHaveBeenCalled(); expect(m.fetch).not.toHaveBeenCalled(); expect(m.sdk).not.toHaveBeenCalled();
  });
  it.each([null, "default", "none", "xhigh", "HIGH", 1, {}])("rejects an invalid runtime effort %j without resolving a key", async reasoningEffort => {
    await expect(chatCompletion(config, "system", messages, 512, {reasoningEffort} as any)).rejects.toMatchObject({status: 400});
    expect(m.key).not.toHaveBeenCalled(); expect(m.fetch).not.toHaveBeenCalled();
  });
});
