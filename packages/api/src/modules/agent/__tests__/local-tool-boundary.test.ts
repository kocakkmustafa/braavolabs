/** Actual local platform parser/dispatch, synthetic child process only.
 * Never invokes an installed Claude CLI or tests its internal tool permissions. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
const m = vi.hoisted(() => ({spawn: vi.fn(), handler: vi.fn(), reply: "", requiresApproval: false}));
vi.mock("node:child_process", () => ({spawn: m.spawn}));
vi.mock("../../../lib/logger", () => ({logger: {info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../registry", () => ({getTool: (name: string) => name === "synthetic_tool" ? {
  name, description: "Synthetic tool", inputSchema: {type: "object"}, handler: m.handler,
  meta: {requiresApproval: m.requiresApproval},
} : undefined}));
import { runLocalAgentLoop } from "../claude-local";
beforeEach(() => {
  vi.clearAllMocks(); m.reply = "Plain reply"; m.requiresApproval = false; m.handler.mockResolvedValue({ok: true});
  m.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      stdin: new Writable({write(_chunk, _encoding, callback) {callback();}, final(callback) {
        callback(); queueMicrotask(() => {child.stdout.write(JSON.stringify({result: m.reply, total_cost_usd: 0.001, usage: {input_tokens: 1, output_tokens: 1}})); child.emit("close", 0);});
      }}),
    });
    return child;
  });
});
const block = (input: unknown) => "```tool_call\n" + JSON.stringify({tool: "synthetic_tool", input}) + "\n```";
const run = (toolNames: string[] = []) => runLocalAgentLoop({systemPrompt: "Synthetic system", userMessage: "Synthetic question", toolNames, maxTurns: 1});
describe("local platform tool dispatch boundary", () => {
  it.each([{input: {}}, {input: []}, {input: {companyId: "synthetic-company"}}])("rejects a fenced call with $input when no tools were requested", async ({input}) => {
    m.reply = block(input);
    const observed = await run().then(() => ({rejected: false, message: ""}), error => ({rejected: true, message: error.message}));
    expect({rejected: observed.rejected, registryCalls: m.handler.mock.calls.length}).toEqual({rejected: true, registryCalls: 0});
    expect(observed.message).toContain("Tool calls are not allowed");
    expect(m.handler).not.toHaveBeenCalled(); expect(m.spawn).toHaveBeenCalledOnce();
  });
  it("rejects multiple valid blocks even when another block is malformed", async () => {
    m.reply = "```tool_call\n{ invalid }\n```\n" + block({}) + "\n" + block({second: true});
    await expect(run()).rejects.toThrow("Tool calls are not allowed"); expect(m.handler).not.toHaveBeenCalled();
  });
  it("keeps a clean reply tools-free", async () => {
    const result = await run(); expect(result.finalContent).toBe("Plain reply"); expect(result.totalToolCalls).toBe(0);
    expect(m.handler).not.toHaveBeenCalled(); expect(m.spawn).toHaveBeenCalledOnce();
  });
  it("preserves execution for a configured named tool", async () => {
    m.reply = block({value: "synthetic"}); const result = await run(["synthetic_tool"]);
    expect(m.handler).toHaveBeenCalledWith({value: "synthetic"}); expect(result.totalToolCalls).toBe(1);
  });
  it("preserves spend approval blocking for a configured tool", async () => {
    m.requiresApproval = true; m.reply = block({}); const result = await run(["synthetic_tool"]);
    expect(result.turns[0].toolCalls[0].error).toContain("spend approval"); expect(m.handler).not.toHaveBeenCalled();
  });
  it("preserves the ungoverned company/tenant boundary for a configured tool", async () => {
    m.reply = block({companyId: "synthetic-company"}); const result = await run(["synthetic_tool"]);
    expect(result.turns[0].toolCalls[0].error).toContain("tenant-scoped pipeline"); expect(m.handler).not.toHaveBeenCalled();
  });
});
