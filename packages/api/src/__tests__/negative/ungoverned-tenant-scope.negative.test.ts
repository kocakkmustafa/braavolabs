/**
 * BRA-P0-07 / SEC-BRA-06 — the UNGOVERNED loops (claude.ts runProviderAgentLoop
 * without govContext, claude-local.ts CLI loop) have no acting company to inject
 * or compare, so a tool that takes a companyId must be refused there — whether
 * the model supplies the key, omits it, or sends a non-object input. Real
 * registry tool (crm_search_contacts); provider / CLI / DB synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const contactFindMany = vi.hoisted(() => vi.fn());
const chat = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../config/env", () => ({
  env: { LLM_PROVIDER: "api", ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "m", OFFLINE_MODE: false, NATIVE_TOOLUSE_PROVIDERS: undefined },
}));
vi.mock("../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/db", () => ({
  prisma: {
    contact: { findMany: contactFindMany },
    steeringMessage: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    activityLog: { create: vi.fn() },
  },
}));
vi.mock("../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/ai-client", async (orig) => ({ ...(await orig<typeof import("../../services/ai-client")>()), chatCompletion: chat }));

import { runProviderAgentLoop } from "../../modules/agent/claude";
import { runLocalAgentLoop } from "../../modules/agent/claude-local";
import { requiresGovernedTenantScope } from "../../modules/agent/tool-executor";
import { getTool } from "../../modules/agent/registry";

const CFG = { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "k" } as any;
const REFUSED = /requires a tenant-scoped pipeline run/;

// argumentsJson / CLI input variants the model could produce
const INPUTS: Array<[string, string]> = [
  ["companyId omitted", '{"query":"a"}'],
  ["another company", '{"query":"a","companyId":"co-b"}'],
  ["operator object", '{"query":"a","companyId":{"not":"x"}}'],
  ["array", '{"query":"a","companyId":["x"]}'],
  ["null", '{"query":"a","companyId":null}'],
  ["empty string", '{"query":"a","companyId":""}'],
  ["input is a JSON string", '"just a string"'],
  ["input is null", "null"],
  ["input is an array", "[1]"],
];

function reply(partial: Record<string, unknown>) {
  return { content: "", inputTokens: 1, outputTokens: 1, model: "m", provider: "GROQ", stopReason: "stop", ...partial };
}

beforeEach(() => { contactFindMany.mockReset().mockResolvedValue([]); chat.mockReset(); spawnMock.mockReset(); });

describe("claude.ts ungoverned path", () => {
  it.each(INPUTS)("%s -> refused, handler/query never reached, no TypeError", async (_l, args) => {
    chat
      .mockResolvedValueOnce(reply({ stopReason: "tool_calls", toolCalls: [{ id: "c1", name: "crm_search_contacts", argumentsJson: args }] }))
      .mockResolvedValue(reply({ content: "done" }));
    const out = await runProviderAgentLoop(
      { systemPrompt: "s", userMessage: "u", toolNames: ["crm_search_contacts"], maxTurns: 3 } as any, CFG);
    const tc = out.turns[0]!.toolCalls[0]!;
    expect(tc.error).toMatch(REFUSED);
    expect(tc.output).toBeNull();
    expect(contactFindMany).not.toHaveBeenCalled();
  });
});

describe("claude-local.ts CLI path", () => {
  function cli(result: string) {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: () => queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ result })));
        child.emit("close", 0);
      }) };
      child.kill = vi.fn();
      return child;
    });
  }
  it.each(INPUTS)("%s -> refused, handler/query never reached, no TypeError", async (_l, args) => {
    cli("```tool_call\n" + `{"tool":"crm_search_contacts","input":${args}}` + "\n```");
    cli("done");
    const out = await runLocalAgentLoop({ systemPrompt: "s", userMessage: "u", toolNames: ["crm_search_contacts"], maxTurns: 3 });
    const tc = out.turns[0]!.toolCalls[0]!;
    expect(tc.error).toMatch(REFUSED);
    expect(contactFindMany).not.toHaveBeenCalled();
  });
});

describe("requiresGovernedTenantScope (shared helper)", () => {
  const crm = getTool("crm_search_contacts");
  it("true for a tool whose schema has companyId, whatever the input (incl. non-objects)", () => {
    for (const input of [undefined, null, "x", [], {}, { companyId: "a" }, { companyId: { not: 1 } }]) {
      expect(requiresGovernedTenantScope(crm, input)).toBe(true);
    }
  });
  it("true when the input carries a companyId even if the schema does not", () => {
    expect(requiresGovernedTenantScope({ inputSchema: { type: "object", properties: {} } }, { companyId: "a" })).toBe(true);
  });
  it("false for a tool/input with no companyId anywhere (control)", () => {
    expect(requiresGovernedTenantScope({ inputSchema: { type: "object", properties: {} } }, { q: 1 })).toBe(false);
    expect(requiresGovernedTenantScope({ inputSchema: { type: "object" } }, null)).toBe(false);
  });
});
