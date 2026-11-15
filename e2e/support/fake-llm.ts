/**
 * Deterministic fake OpenAI-compatible LLM server for E2E (BRA-P0-10).
 *
 * Why this exists: the real API talks to a tenant's CUSTOM provider over plain
 * `POST {baseUrl}/chat/completions`. Pointing a throwaway tenant at this server
 * lets journeys run the REAL agent loop, tool executor, approval gate and
 * outbound gates with ZERO external network and no secrets.
 *
 * Scenario selection is by a marker in the SYSTEM message (the agent's
 * systemPrompt): `[e2e:<scenario>]` or `[e2e:<scenario>;key=value;...]`.
 * The server is stateless per request: the turn is derived from the message
 * list (a trailing `tool` message means "the tool result came back").
 *
 * Every request is recorded; specs read `GET /__requests` (and `POST /__reset`)
 * through `fake-llm-client.ts` to prove what the model saw and that nothing
 * else left the machine.
 *
 * Runs as its own process (Playwright webServer): `node e2e/support/fake-llm.ts`.
 * Only erasable TypeScript syntax and node: imports here — Node strips types.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.E2E_FAKE_LLM_PORT ?? 4314);

interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface RecordedRequest {
  at: string;
  path: string;
  scenario: string | null;
  model: string | null;
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
  hasAuthorization: boolean;
}

interface Reply {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

const requests: RecordedRequest[] = [];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text : ""))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function parseMarker(system: string): { scenario: string | null; opts: Record<string, string> } {
  const m = /\[e2e:([a-z0-9-]+)((?:;[^\]]*)?)\]/.exec(system);
  if (!m) return { scenario: null, opts: {} };
  const opts: Record<string, string> = {};
  for (const pair of m[2].split(";").filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i > 0) opts[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return { scenario: m[1], opts };
}

/** Deterministic replies. `toolResult` is the text of the last `tool` message, or null on the first turn. */
function reply(scenario: string, opts: Record<string, string>, toolResult: string | null): Reply | null {
  switch (scenario) {
    case "chat":
      return { content: "## Reasoning\nE2E fake model answers the greeting.\n\nE2E-CHAT-REPLY: Merhaba! Ben sahte E2E asistanıyım." };

    case "draft-email":
      if (toolResult === null) {
        return {
          toolCalls: [{
            name: "create_draft",
            args: {
              companyId: opts.companyId,
              type: "EMAIL",
              title: "E2E welcome email",
              body: "E2E-DRAFT-BODY: Hello from the fake model. This is only a draft.",
            },
          }],
        };
      }
      return { content: "## Reasoning\nDraft saved for human review.\n\nE2E-DRAFT-DONE" };

    case "outbound-gated":
      if (toolResult === null) {
        return {
          toolCalls: [
            { name: "email_send_sequence", args: { sequenceId: "seq-e2e", contactId: "contact-e2e" } },
            { name: "make_outbound_call", args: { voiceAgentId: "va-e2e", calleeNumber: "+14155550101", prompt: "E2E call" } },
          ],
        };
      }
      return { content: "## Reasoning\nBoth outbound tools were refused.\n\nE2E-OUTBOUND-REFUSED" };

    case "outbound-approval":
      if (toolResult === null) {
        return {
          toolCalls: [{
            name: "ad_spend",
            args: { companyId: opts.companyId, platform: "google_ads", budgetUsd: 5, campaign: "E2E campaign" },
          }],
        };
      }
      return { content: "## Reasoning\nThe spend is paused for human approval.\n\nE2E-OUTBOUND-PAUSED" };

    default:
      return null;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

let callSeq = 0;

async function handleCompletion(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  let body: { model?: string; messages?: WireMessage[]; tools?: Array<{ function?: { name?: string } }> };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: { message: "e2e fake-llm: invalid JSON body" } });
    return;
  }
  const messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const { scenario, opts } = parseMarker(system);
  const last = messages[messages.length - 1];
  const toolResult = last?.role === "tool" ? textOf(last.content) : null;

  requests.push({
    at: new Date().toISOString(),
    path,
    scenario,
    model: body.model ?? null,
    system,
    messages: messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    toolNames: (body.tools ?? []).map((t) => t.function?.name ?? ""),
    hasAuthorization: typeof req.headers.authorization === "string",
  });

  const r = scenario ? reply(scenario, opts, toolResult) : null;
  if (!r) {
    send(res, 400, { error: { message: `e2e fake-llm: no scenario for marker ${scenario ?? "(none)"}` } });
    return;
  }

  callSeq += 1;
  const toolCalls = (r.toolCalls ?? []).map((tc, i) => ({
    id: `call_e2e_${callSeq}_${i}`,
    type: "function",
    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
  }));
  send(res, 200, {
    id: `chatcmpl-e2e-${callSeq}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model: body.model ?? "e2e-fake-model",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: toolCalls.length > 0 ? null : (r.content ?? ""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const method = req.method ?? "GET";
  void (async () => {
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true });
    if (method === "GET" && (path === "/v1/models" || path === "/models")) {
      return send(res, 200, { object: "list", data: [{ id: "e2e-fake-model", object: "model" }] });
    }
    if (method === "GET" && path === "/__requests") return send(res, 200, requests);
    if (method === "POST" && path === "/__reset") {
      requests.length = 0;
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return handleCompletion(req, res, path);
    }
    send(res, 404, { error: { message: `e2e fake-llm: unknown route ${method} ${path}` } });
  })().catch(() => {
    if (!res.headersSent) send(res, 500, { error: { message: "e2e fake-llm: internal error" } });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`e2e fake-llm listening on 127.0.0.1:${PORT}`);
});
