/**
 * Normalized tool contract tests (E2/T3) — mocked fetch / mocked Anthropic
 * SDK, zero network. Covers every translation direction:
 *
 *   OpenAI-compatible (10 providers) — request: tools:[{type:"function"}] +
 *     tool_choice:"auto"; transcript round-trip (assistant tool_calls +
 *     role:"tool" results); response: message.tool_calls → normalized
 *     ChatToolCall[]; o-series max_completion_tokens quirk.
 *   Google Gemini — request: tools:[{functionDeclarations}] + functionCall /
 *     functionResponse content projection; response: functionCall parts →
 *     normalized ChatToolCall[] with synthetic ids.
 *   Anthropic — canonical-transcript projection to tool_use / tool_result
 *     blocks (plan §2.2 / A8) and normalized response.
 *   Capability gate — TOOL_INCAPABLE pre-flight, NATIVE_TOOLUSE_PROVIDERS
 *     kill-switch, runtime 400-"tool" → ToolsUnsupportedError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (must be declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-20250514",
  OFFLINE_MODE: false,
  NATIVE_TOOLUSE_PROVIDERS: undefined as string | undefined,
}));
vi.mock("../../config/env", () => ({ env: envMock }));

vi.mock("../../lib/db", () => ({
  prisma: { userAIConfig: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

vi.mock("../../lib/encryption", () => ({
  decryptForTenant: vi.fn(),
  encryptForTenant: vi.fn(() => "encrypted"),
}));

// Skip real DNS resolution in the SSRF guard (own suite: ssrf.test.ts).
vi.mock("../../lib/ssrf", () => ({
  assertSafeExternalUrl: async () => {},
  SsrfError: class SsrfError extends Error {},
}));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Anthropic SDK — fully mocked so the projection tests never hit the wire.
const anthropicCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: (...a: unknown[]) => anthropicCreate(...a) };
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_opts: unknown) {}
  },
}));

import {
  chatCompletion,
  supportsNativeToolUse,
  ToolsUnsupportedError,
  toAnthropicMessages,
  toGeminiContents,
  type ChatMessage,
  type ChatToolDef,
} from "../ai-client";

const TOOLS: ChatToolDef[] = [
  {
    name: "get_time",
    description: "Return the current time for a timezone",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string" } },
      required: ["timezone"],
    },
  },
];

function stubFetch(impl: (...a: any[]) => any) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

function openAIResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  envMock.NATIVE_TOOLUSE_PROVIDERS = undefined;
  anthropicCreate.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

// ── OpenAI-compatible translation ──

describe("OpenAI-compatible tool translation", () => {
  it("sends tools as [{type:'function',function:{...}}] with tool_choice:'auto'", async () => {
    const f = stubFetch(async () =>
      openAIResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );

    await chatCompletion(
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
      "sys",
      [{ role: "user", content: "what time is it?" }],
      4096,
      { tools: TOOLS },
    );

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Return the current time for a timezone",
          parameters: TOOLS[0].parameters,
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.max_tokens).toBe(4096);
  });

  it("normalizes message.tool_calls into ChatToolCall[] (stopReason=tool_calls, toolUseMode=native)", async () => {
    stubFetch(async () =>
      openAIResponse({
        choices: [
          {
            message: {
              content: null, // tool-call-only answers have null content
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_time", arguments: '{"timezone":"Europe/Istanbul"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );

    const result = await chatCompletion(
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
      "sys",
      [{ role: "user", content: "time?" }],
      4096,
      { tools: TOOLS },
    );

    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_time", argumentsJson: '{"timezone":"Europe/Istanbul"}' },
    ]);
    expect(result.content).toBe(""); // null → ""
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolUseMode).toBe("native");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
  });

  it("round-trips the canonical transcript: assistant toolCalls + role:'tool' results", async () => {
    const f = stubFetch(async () =>
      openAIResponse({
        choices: [{ message: { content: "It is 14:00 in Istanbul." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      }),
    );

    const transcript: ChatMessage[] = [
      { role: "user", content: "time?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_abc", name: "get_time", argumentsJson: '{"timezone":"Europe/Istanbul"}' },
        ],
      },
      { role: "tool", toolCallId: "call_abc", content: '{"time":"14:00"}' },
    ];

    const result = await chatCompletion(
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "dsk" },
      "sys",
      transcript,
      4096,
      { tools: TOOLS },
    );

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "time?" },
      {
        role: "assistant",
        content: null, // "" normalized to null next to tool_calls
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "get_time", arguments: '{"timezone":"Europe/Istanbul"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"time":"14:00"}' },
    ]);
    expect(result.content).toBe("It is 14:00 in Istanbul.");
    expect(result.stopReason).toBe("stop");
  });

  it("tolerates shim quirks: missing tool_call id → synthetic, object arguments → stringified", async () => {
    stubFetch(async () =>
      openAIResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "get_time", arguments: { timezone: "UTC" } } }],
            },
            finish_reason: "stop", // Ollama reports "stop" even with tool calls
          },
        ],
      }),
    );

    const result = await chatCompletion(
      { provider: "OLLAMA", model: "qwen2.5:7b", apiKey: "" },
      "sys",
      [{ role: "user", content: "time?" }],
      4096,
      { tools: TOOLS },
    );

    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "get_time", argumentsJson: '{"timezone":"UTC"}' },
    ]);
    // presence of tool calls wins over the shim's finish_reason
    expect(result.stopReason).toBe("tool_calls");
  });

  it("uses max_completion_tokens (not max_tokens) for OpenAI o-series models", async () => {
    const f = stubFetch(async () =>
      openAIResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {},
      }),
    );

    await chatCompletion(
      { provider: "OPENAI", model: "o1", apiKey: "sk" },
      "sys",
      [{ role: "user", content: "hi" }],
      2048,
      { tools: TOOLS },
    );

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it("without tools the wire format is unchanged (no tools key, legacy messages, max_tokens)", async () => {
    const f = stubFetch(async () =>
      openAIResponse({
        choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const result = await chatCompletion(
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
      "sys",
      [{ role: "user", content: "hello" }],
    );

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    expect(result.content).toBe("plain");
    expect(result.toolCalls).toBeUndefined();
    expect(result.toolUseMode).toBeUndefined();
    expect(result.stopReason).toBe("stop");
  });
});

// ── Google Gemini translation ──

describe("Gemini tool translation", () => {
  it("sends functionDeclarations and projects the transcript to functionCall/functionResponse parts", async () => {
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "It is 14:00." }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5 },
      }),
    }));

    const transcript: ChatMessage[] = [
      { role: "user", content: "time?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "gemini_call_0", name: "get_time", argumentsJson: '{"timezone":"Europe/Istanbul"}' },
        ],
      },
      { role: "tool", toolCallId: "gemini_call_0", content: '{"time":"14:00"}' },
    ];

    const result = await chatCompletion(
      { provider: "GOOGLE", model: "gemini-1.5-pro", apiKey: "gk" },
      "sys",
      transcript,
      4096,
      { tools: TOOLS },
    );

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_time",
            description: "Return the current time for a timezone",
            parameters: TOOLS[0].parameters,
          },
        ],
      },
    ]);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "time?" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "get_time", args: { timezone: "Europe/Istanbul" } } }],
      },
      {
        role: "user",
        // functionResponse name resolved from the assistant turn via toolCallId
        parts: [{ functionResponse: { name: "get_time", response: { time: "14:00" } } }],
      },
    ]);
    expect(result.content).toBe("It is 14:00.");
    expect(result.stopReason).toBe("stop");
  });

  it("normalizes functionCall parts into ChatToolCall[] with synthetic ids", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: "Let me check." },
                { functionCall: { name: "get_time", args: { timezone: "UTC" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
      }),
    }));

    const result = await chatCompletion(
      { provider: "GOOGLE", model: "gemini-1.5-pro", apiKey: "gk" },
      "sys",
      [{ role: "user", content: "time?" }],
      4096,
      { tools: TOOLS },
    );

    expect(result.toolCalls).toEqual([
      // ids are numbered over the functionCall parts (not the raw part index)
      { id: "gemini_call_0", name: "get_time", argumentsJson: '{"timezone":"UTC"}' },
    ]);
    expect(result.content).toBe("Let me check.");
    expect(result.stopReason).toBe("tool_calls"); // functionCall presence wins
    expect(result.toolUseMode).toBe("native");
  });

  it("wraps non-JSON tool results as {result: string} in functionResponse", () => {
    const contents = toGeminiContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "plain text output" },
    ]);

    expect(contents[1]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_time", response: { result: "plain text output" } } },
      ],
    });
  });
});

// ── Anthropic projection (canonical transcript → SDK format) ──

describe("Anthropic projection", () => {
  it("projects tools to input_schema and toolCalls/tool results to tool_use/tool_result blocks", async () => {
    anthropicCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Done." },
      ],
      usage: { input_tokens: 11, output_tokens: 12 },
      stop_reason: "end_turn",
    });

    const transcript: ChatMessage[] = [
      { role: "user", content: "time?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          { id: "toolu_1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", content: '{"time":"14:00"}' },
      { role: "tool", toolCallId: "toolu_2", content: "second result" },
    ];

    const result = await chatCompletion(
      { provider: "ANTHROPIC", model: "claude-sonnet-4-20250514", apiKey: "sk-ant" },
      "sys",
      transcript,
      4096,
      { tools: TOOLS },
    );

    expect(anthropicCreate).toHaveBeenCalledOnce();
    const req = anthropicCreate.mock.calls[0][0];
    expect(req.tools).toEqual([
      {
        name: "get_time",
        description: "Return the current time for a timezone",
        input_schema: TOOLS[0].parameters,
      },
    ]);
    expect(req.messages).toEqual([
      { role: "user", content: "time?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_time", input: { timezone: "UTC" } },
        ],
      },
      {
        role: "user",
        // consecutive tool results merged into ONE user message
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: '{"time":"14:00"}' },
          { type: "tool_result", tool_use_id: "toolu_2", content: "second result" },
        ],
      },
    ]);
    expect(result.content).toBe("Done.");
    expect(result.stopReason).toBe("stop");
  });

  it("normalizes tool_use response blocks into ChatToolCall[]", async () => {
    anthropicCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_9", name: "get_time", input: { timezone: "UTC" } },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
      stop_reason: "tool_use",
    });

    const result = await chatCompletion(
      { provider: "ANTHROPIC", model: "claude-sonnet-4-20250514", apiKey: "sk-ant" },
      "sys",
      [{ role: "user", content: "time?" }],
      4096,
      { tools: TOOLS },
    );

    expect(result.toolCalls).toEqual([
      { id: "toolu_9", name: "get_time", argumentsJson: '{"timezone":"UTC"}' },
    ]);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolUseMode).toBe("native");
  });

  it("without tools the legacy request shape is preserved (no tools key, string contents)", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });

    const result = await chatCompletion(
      { provider: "ANTHROPIC", model: "claude-sonnet-4-20250514", apiKey: "sk-ant" },
      "sys",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "again" },
      ],
    );

    const req = anthropicCreate.mock.calls[0][0];
    expect(req.tools).toBeUndefined();
    expect(req.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "again" },
    ]);
    expect(result.content).toBe("hi");
  });

  it("toAnthropicMessages drops system messages and keeps plain turns as strings", () => {
    const projected = toAnthropicMessages([
      { role: "system", content: "ignored" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(projected).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  });
});

// ── Capability gate: pre-flight + kill-switch + runtime 400 ──

describe("native tool-use capability gate", () => {
  it("supportsNativeToolUse capability table", () => {
    // known-capable
    expect(supportsNativeToolUse("GROQ", "llama-3.3-70b-versatile")).toBe(true);
    expect(supportsNativeToolUse("DEEPSEEK", "deepseek-chat")).toBe(true);
    // unknown → optimistic (runtime 400 is the safety net)
    expect(supportsNativeToolUse("OLLAMA", "qwen2.5:7b")).toBe(true);
    expect(supportsNativeToolUse("OPENROUTER", "some/new-model")).toBe(true);
    // known-incapable
    expect(supportsNativeToolUse("OLLAMA", "gemma3:4b")).toBe(false);
    expect(supportsNativeToolUse("LMSTUDIO", "google/gemma-3-4b-it")).toBe(false);
    expect(supportsNativeToolUse("DEEPSEEK", "deepseek-reasoner")).toBe(false);
    expect(supportsNativeToolUse("OPENAI", "o1-mini")).toBe(false);
    expect(supportsNativeToolUse("OPENAI", "o1")).toBe(true); // full o1 has tools
    // ANTHROPIC never gated
    expect(supportsNativeToolUse("ANTHROPIC", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("pre-flight: incapable model throws ToolsUnsupportedError WITHOUT hitting the wire", async () => {
    const f = stubFetch(async () => {
      throw new Error("must not be called");
    });

    await expect(
      chatCompletion(
        { provider: "OLLAMA", model: "gemma3:4b", apiKey: "" },
        "sys",
        [{ role: "user", content: "hi" }],
        4096,
        { tools: TOOLS },
      ),
    ).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(f).not.toHaveBeenCalled();
  });

  it("kill-switch: provider removed from NATIVE_TOOLUSE_PROVIDERS throws pre-flight", async () => {
    envMock.NATIVE_TOOLUSE_PROVIDERS = "OPENAI,MISTRAL"; // GROQ removed
    const f = stubFetch(async () => {
      throw new Error("must not be called");
    });

    await expect(
      chatCompletion(
        { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
        "sys",
        [{ role: "user", content: "hi" }],
        4096,
        { tools: TOOLS },
      ),
    ).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(f).not.toHaveBeenCalled();
    expect(supportsNativeToolUse("GROQ", "llama-3.3-70b-versatile")).toBe(false);
    expect(supportsNativeToolUse("OPENAI", "gpt-4o")).toBe(true);
  });

  it("kill-switch never gates the tool-free path (legacy calls unaffected)", async () => {
    envMock.NATIVE_TOOLUSE_PROVIDERS = ""; // everything switched off
    stubFetch(async () =>
      openAIResponse({
        choices: [{ message: { content: "still works" }, finish_reason: "stop" }],
        usage: {},
      }),
    );

    const result = await chatCompletion(
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
      "sys",
      [{ role: "user", content: "hi" }],
    );
    expect(result.content).toBe("still works");
  });

  it("runtime: provider 400 mentioning tools → ToolsUnsupportedError (single attempt, no retry)", async () => {
    const f = stubFetch(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => '{"error":{"message":"this model does not support tools"}}',
      json: async () => ({}),
    }));

    await expect(
      chatCompletion(
        // unknown model → passes pre-flight optimistically, fails at runtime
        { provider: "GROQ", model: "brand-new-model", apiKey: "gsk" },
        "sys",
        [{ role: "user", content: "hi" }],
        4096,
        { tools: TOOLS },
      ),
    ).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(f).toHaveBeenCalledOnce(); // 400 is not retryable
  });

  it("runtime: a 400 mentioning tools WITHOUT a tools payload stays a plain Error", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "bad request: tool parameter invalid",
      json: async () => ({}),
    }));

    const err = await chatCompletion(
      { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk" },
      "sys",
      [{ role: "user", content: "hi" }],
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolsUnsupportedError);
    expect(String(err.message)).toContain("GROQ API error 400");
  });

  it("Gemini runtime 400 mentioning tools → ToolsUnsupportedError", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => "Function calling is not enabled for this model",
      json: async () => ({}),
    }));

    await expect(
      chatCompletion(
        { provider: "GOOGLE", model: "gemini-experimental", apiKey: "gk" },
        "sys",
        [{ role: "user", content: "hi" }],
        4096,
        { tools: TOOLS },
      ),
    ).rejects.toBeInstanceOf(ToolsUnsupportedError);
  });
});
