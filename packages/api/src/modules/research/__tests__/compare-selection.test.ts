import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({create: vi.fn(), update: vi.fn(), company: vi.fn(), list: vi.fn(), run: vi.fn()}));
vi.mock("../../../lib/db", () => ({prisma: {company: {findFirst: m.company}, webResearchSession: {create: m.create, update: m.update}}}));
vi.mock("../../../lib/logger", () => ({logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../../../services/provider-chain", () => ({listTenantProviderLinks: m.list}));
vi.mock("../../agent/claude", () => ({runAgentLoop: m.run}));
vi.mock("../../../middleware/auth", () => ({authMiddleware: (_q: any, _s: any, next: any) => next()}));
vi.mock("../../../middleware/rateLimit", () => ({rateLimit: () => (_q: any, _s: any, next: any) => next()}));
vi.mock("../cascade.service", () => ({runTenantCascade: vi.fn()}));
import { startCompare } from "../research.service";
import { researchRouter } from "../research.router";
const selections = [{provider: "OPENAI", model: "gpt-4o"}];
beforeEach(() => {
 vi.clearAllMocks(); m.company.mockResolvedValue({id: "company"}); m.create.mockResolvedValue({id: "session"}); m.update.mockResolvedValue({});
 m.list.mockResolvedValue([{provider: "OPENAI", config: {provider: "OPENAI", model: "gpt-4o", apiKey: "synthetic"}}]);
 m.run.mockResolvedValue({finalContent: "answer", totalCostUsd: 1, totalInputTokens: 1, totalOutputTokens: 1});
});
async function request(selections: unknown) {
 const route = (researchRouter as any).stack.find((l: any) => Array.isArray(l.route?.path) && l.route.path.includes("/compare/selected")).route;
 const res = {status: vi.fn().mockReturnThis(), json: vi.fn()}, next = vi.fn();
 await route.stack.at(-1).handle({path: "/compare/selected", body: {companyId: "company", query: "question", selections}, auth: {tenantId: "authenticated-tenant"}}, res, next);
 return {res, next};
}
describe("explicit compare router/service", () => {
 it("validates effort for service callers before persistence, even after a supported selection", async () => {
  m.list.mockResolvedValue([{provider: "CEREBRAS", config: {provider: "CEREBRAS", model: "gpt-oss-120b", apiKey: "synthetic"}},
    {provider: "OPENAI", config: {provider: "OPENAI", model: "gpt-4o", apiKey: "synthetic"}}]);
  await expect(startCompare({tenantId: "authenticated-tenant", companyId: "company", query: "question",
    selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "low"}, {...selections[0], reasoningEffort: "high"}] as any})).rejects.toMatchObject({statusCode: 400});
  expect(m.create).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled();
 });
 it("uses authenticated tenant and exact model", async () => {
  const {res,next} = await request(selections); expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(201);
  expect(m.company).toHaveBeenCalledWith({where: {id: "company", tenantId: "authenticated-tenant"}});
  expect(m.list).toHaveBeenCalledWith("authenticated-tenant");
  await vi.waitFor(() => expect(m.run).toHaveBeenCalled()); expect(m.run.mock.calls[0][0].aiConfigOverride).toMatchObject(selections[0]);
 });
 it.each([undefined, [], [{provider: "OPENAI", model: "missing"}], Array(4).fill(selections[0]), [{...selections[0], apiKey: "injected"}]].map(selections => ({selections})))("rejects invalid selectors before session/inference: %j", async ({selections}) => {
  const {next} = await request(selections); expect(next).toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled();
 });
 it("rejects a company outside the authenticated tenant before validation or inference", async () => {
  m.company.mockResolvedValue(null);
  const {next} = await request(selections);
  expect(next.mock.calls[0][0]).toMatchObject({statusCode: 404});
  expect(m.list).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled();
 });
 it("rejects unavailable tenant pair before persistence", async () => {
  m.list.mockResolvedValue([]);
  await expect(startCompare({tenantId: "other-tenant", companyId: "company", query: "question", selections})).rejects.toMatchObject({statusCode: 400});
  expect(m.create).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled();
 });
});
