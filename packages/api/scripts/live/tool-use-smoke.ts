/**
 * LIVE tool-use smoke test (MOCK=0) — plan-e2 T3 evidence script.
 *
 * Makes a REAL provider call with one synthetic tool (`get_time`) and
 * asserts the model answers with a native tool call, then feeds the tool
 * result back and asserts a grounded final answer. NOT part of the unit
 * suite (lives outside src/, vitest never picks it up) and NOT run in CI —
 * requires a real key/endpoint, so it runs only on an operator machine.
 *
 * Usage (repo root .env supplies DATABASE_URL etc. for module imports):
 *   pnpm --filter api exec tsx scripts/live/tool-use-smoke.ts --provider GROQ
 *   pnpm --filter api exec tsx scripts/live/tool-use-smoke.ts --provider OLLAMA --model qwen2.5:7b
 *   pnpm --filter api exec tsx scripts/live/tool-use-smoke.ts --provider DEEPSEEK --model deepseek-chat
 *
 * Key resolution: SMOKE_<PROVIDER>_KEY > <PROVIDER>_API_KEY env. Local
 * providers (OLLAMA / LMSTUDIO / CUSTOM) run keyless; OLLAMA needs
 * `ollama serve` + the model pulled.
 *
 * Exit code 0 = both turns OK (evidence JSON on stdout); 1 = failure.
 */
import {
  chatCompletion,
  PROVIDER_DEFAULT_MODELS,
  type AIProviderType,
  type ChatMessage,
  type ChatToolDef,
} from "../../src/services/ai-client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const provider = (arg("provider") ?? "GROQ").toUpperCase() as AIProviderType;
const model = arg("model") ?? PROVIDER_DEFAULT_MODELS[provider];
const baseUrl = arg("base-url");
const apiKey =
  process.env[`SMOKE_${provider}_KEY`] ?? process.env[`${provider}_API_KEY`] ?? "";

const TOOL: ChatToolDef = {
  name: "get_time",
  description:
    "Returns the current time for an IANA timezone. Always call this instead of guessing the time.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "IANA timezone, e.g. Europe/Istanbul" },
    },
    required: ["timezone"],
  },
};

async function main(): Promise<void> {
  const config = { provider, model, apiKey, ...(baseUrl ? { baseUrl } : {}) };
  const system = "You are a precise assistant. Use the provided tools when relevant.";
  const transcript: ChatMessage[] = [
    { role: "user", content: "What time is it in Istanbul right now? Use the get_time tool." },
  ];

  // Turn 1 — the model must request the tool natively.
  const turn1 = await chatCompletion(config, system, transcript, 1024, { tools: [TOOL] });
  if (!turn1.toolCalls?.length) {
    console.error(
      JSON.stringify({ ok: false, provider, model, reason: "no native tool_calls in turn 1", turn1 }, null, 2),
    );
    process.exit(1);
  }

  // Turn 2 — feed the tool result back, expect a grounded final answer.
  const call = turn1.toolCalls[0];
  const toolResult = JSON.stringify({ timezone: "Europe/Istanbul", time: "14:00", date: "2026-07-02" });
  transcript.push(
    { role: "assistant", content: turn1.content, toolCalls: turn1.toolCalls },
    { role: "tool", toolCallId: call.id, content: toolResult },
  );
  const turn2 = await chatCompletion(config, system, transcript, 1024, { tools: [TOOL] });

  const grounded = /14[:.]?00|2\s*(pm|p\.m\.)/i.test(turn2.content);
  const evidence = {
    ok: grounded,
    provider,
    model,
    turn1: {
      stopReason: turn1.stopReason,
      toolUseMode: turn1.toolUseMode,
      toolCalls: turn1.toolCalls,
      tokens: { in: turn1.inputTokens, out: turn1.outputTokens },
    },
    turn2: {
      stopReason: turn2.stopReason,
      content: turn2.content,
      tokens: { in: turn2.inputTokens, out: turn2.outputTokens },
    },
    groundedFinalAnswer: grounded,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(grounded ? 0 : 1);
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      { ok: false, provider, model, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      null,
      2,
    ),
  );
  process.exit(1);
});
