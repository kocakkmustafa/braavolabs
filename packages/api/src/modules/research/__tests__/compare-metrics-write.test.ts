import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({create: vi.fn(), update: vi.fn(), company: vi.fn(), list: vi.fn(), run: vi.fn()}));
vi.mock("../../../lib/db", () => ({prisma: {company: {findFirst: m.company}, webResearchSession: {create: m.create, update: m.update}}}));
vi.mock("../../../lib/logger", () => ({logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../../../services/provider-chain", () => ({listTenantProviderLinks: m.list}));
vi.mock("../../agent/claude", () => ({runAgentLoop: m.run}));
vi.mock("../cascade.service", () => ({runTenantCascade: vi.fn()}));
import { startCompare, augmentFindingsWithMultiModel } from "../research.service";
import { readCompareMetrics } from "../../../services/compare-metrics";
const link = {provider: "OPENAI", config: {provider: "OPENAI", model: "gpt-4o", apiKey: "synthetic"}};
const session = {id: "s", tenantId: "t", query: "q", maxCostUsd: 1};
beforeEach(() => {
 vi.clearAllMocks(); m.company.mockResolvedValue({id: "company"}); m.create.mockResolvedValue({id: "session"}); m.update.mockResolvedValue({});
 m.list.mockResolvedValue([link]);
 m.run.mockResolvedValue({finalContent: '{"synthesis":"s","consensus":[],"disagreements":[],"finalAnswer":"final"}', totalCostUsd: 0.1, totalInputTokens: 3, totalOutputTokens: 4});
});
describe("metrics write points", () => {
 it("runCompareSession writes metrics next to summary/claims/multiModel", async () => {
  await startCompare({tenantId: "t", companyId: "company", query: "q", selections: [{provider: "OPENAI", model: "gpt-4o"}]});
  await vi.waitFor(() => expect(m.update.mock.calls.some(c => c[0].data.findings)).toBe(true));
  const f = m.update.mock.calls.find(c => c[0].data.findings)![0].data.findings;
  expect(f.summary).toBe("final"); expect(f.claims).toEqual([]); expect(f.multiModel).toBeDefined();
  expect(readCompareMetrics(f)).not.toBeNull();
  expect(f.metrics.totals.succeeded).toBe(1);
 });
 it("augment adds metrics, keeps summary/claims, replaces forged metrics", async () => {
  const out = await augmentFindingsWithMultiModel(session, [], {summary: "S", claims: [{claim: "c", citations: []}], metrics: {forged: true}}, 0);
  const f = out.findings as any;
  expect(f.summary).toBe("S"); expect(f.claims).toHaveLength(1); expect(f.multiModel).toBeDefined();
  expect(readCompareMetrics(f)).not.toBeNull(); expect(f.metrics.forged).toBeUndefined();
 });
 it("augment failure strips forged metrics and keeps the rest", async () => {
  m.list.mockResolvedValue([]);
  const out = await augmentFindingsWithMultiModel(session, [], {summary: "S", claims: [], metrics: {forged: true}}, 0);
  expect(out.findings).toEqual({summary: "S", claims: []}); expect(out.addedCostUsd).toBe(0);
 });
});
