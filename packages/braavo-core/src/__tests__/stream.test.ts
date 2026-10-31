/** Injected transport only: no network, no SDK, synthetic keys. */
import { describe, expect, it, vi } from "vitest";
import { collectStream, parseSse, ProviderHttpError, streamAnthropic, streamOpenAICompatible } from "../stream";

async function* chunks(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

function fakeFetch(body: string, init: { status?: number; split?: number } = {}) {
  const split = init.split ?? 7;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += split) parts.push(body.slice(i, i + split));
  return vi.fn(async () => ({ ok: (init.status ?? 200) < 300, status: init.status ?? 200, body: chunks(...parts), text: async () => body }));
}

describe("parseSse", () => {
  it("handles split chunks, CRLF, comments, multi-line data and event names", async () => {
    const out = [];
    for await (const m of parseSse(chunks(": keepalive\r\n", "event: ping\r\ndata: a\r\nda", "ta: b\r\n\r\ndata: {\"x\":1}\n\n", "data: tail"))) out.push(m);
    expect(out).toEqual([{ event: "ping", data: "a\nb" }, { event: undefined, data: "{\"x\":1}" }, { event: undefined, data: "tail" }]);
  });

  it("reads a WHATWG ReadableStream body", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: hi\n\n")); c.close(); } });
    const out = [];
    for await (const m of parseSse(stream)) out.push(m.data);
    expect(out).toEqual(["hi"]);
  });
});

describe("streamOpenAICompatible", () => {
  it("streams text, reasoning, split tool calls and usage; sends effort wire fields", async () => {
    const body = sse(
      { choices: [{ delta: { reasoning: "think " } }] },
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_", arguments: "{\"q\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: "\"rival\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
      "[DONE]",
    );
    const fetchImpl = fakeFetch(body);
    const result = await collectStream(streamOpenAICompatible(
      { provider: "GROQ", model: "openai/gpt-oss-120b", apiKey: "synthetic-key" },
      { system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 256, tools: [{ name: "web_search", description: "d", inputSchema: { type: "object" } }], extraBody: { reasoning_effort: "low" } },
      { fetchImpl },
    ));
    expect(result).toEqual({ text: "Hello", reasoning: "think ", toolCalls: [{ id: "call_1", name: "web_search", argumentsJson: "{\"q\":\"rival\"}" }], inputTokens: 12, outputTokens: 5, stopReason: "tool_use" });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer synthetic-key");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: "openai/gpt-oss-120b", max_tokens: 256, stream: true, stream_options: { include_usage: true }, reasoning_effort: "low" });
    expect(sent.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(sent.tools[0].function.name).toBe("web_search");
  });

  it("omits stream_options and auth for keyless local servers and honors a custom base URL", async () => {
    const fetchImpl = fakeFetch(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"));
    const result = await collectStream(streamOpenAICompatible({ provider: "OLLAMA", model: "qwen", baseUrl: "http://127.0.0.1:11434/v1/" }, { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, { fetchImpl }));
    expect(result.text).toBe("ok"); expect(result.stopReason).toBe("end_turn");
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).stream_options).toBeUndefined();
  });

  it("serializes assistant tool calls and tool results in the request", async () => {
    const fetchImpl = fakeFetch(sse("[DONE]"));
    await collectStream(streamOpenAICompatible({ provider: "OPENAI", model: "m", apiKey: "k" }, {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", argumentsJson: "{}" }] },
        { role: "tool", toolCallId: "c1", content: "result" },
      ], maxTokens: 10,
    }, { fetchImpl }));
    const messages = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).messages;
    expect(messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
  });

  it("raises a typed error with a bounded detail on HTTP failure", async () => {
    const fetchImpl = fakeFetch("x".repeat(500), { status: 429 });
    await expect(collectStream(streamOpenAICompatible({ provider: "GROQ", model: "m" }, { messages: [], maxTokens: 1 }, { fetchImpl }))).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.status === 429 && e.message.length < 260,
    );
    await expect(collectStream(streamOpenAICompatible({ provider: "CUSTOM", model: "m" }, { messages: [], maxTokens: 1 }, { fetchImpl }))).rejects.toThrow(/base URL required/);
  });
});

describe("streamAnthropic", () => {
  it("maps official SDK stream events to normalized events", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "web_fetch" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"url\":" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"https://rival.example\"}" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ];
    const stream = vi.fn(async function* () { yield* events; });
    const client = { messages: { stream } };
    const result = await collectStream(streamAnthropic(client, "claude-opus-5-5", {
      system: "sys", maxTokens: 1000, extraBody: { output_config: { effort: "low" } },
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", toolCalls: [{ id: "t0", name: "x", argumentsJson: "{\"k\":1}" }] }, { role: "tool", toolCallId: "t0", content: "r" }],
    }));
    expect(result).toEqual({ text: "Checking", reasoning: "plan", toolCalls: [{ id: "toolu_1", name: "web_fetch", argumentsJson: "{\"url\":\"https://rival.example\"}" }], inputTokens: 30, outputTokens: 42, stopReason: "tool_use" });
    const params = stream.mock.calls[0][0] as any;
    expect(params).toMatchObject({ model: "claude-opus-5-5", max_tokens: 1000, system: "sys", output_config: { effort: "low" } });
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t0", name: "x", input: { k: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "r" }] },
    ]);
  });

  it("reports refusals as a stop reason", async () => {
    const client = { messages: { stream: async function* () { yield { type: "message_delta", delta: { stop_reason: "refusal" } }; } } };
    expect((await collectStream(streamAnthropic(client, "claude-opus-5-5", { messages: [{ role: "user", content: "q" }], maxTokens: 10 }))).stopReason).toBe("refusal");
  });
});
