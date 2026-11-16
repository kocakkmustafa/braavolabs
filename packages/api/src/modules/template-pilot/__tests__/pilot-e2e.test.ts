/**
 * BRA-P2-03b — pilot şablonu uçtan uca (servis düzeyi, bellek içi sahte tx):
 * install → şirket materialise → run taslağı. Sayılar senaryo sabitinden okunur.
 * Üretim koduna dokunmaz; gerçek DB gerekmez.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  template: null as Row | null,
  txCount: 0,
  seq: 0,
  plan: "TEAM" as string,
}));

function fakeTx() {
  const t = store.tables;
  const insert = (name: string) => async ({ data }: { data: Row }) => {
    const row = { id: `${name}-${++store.seq}`, ...data };
    (t[name] ??= []).push(row);
    return row;
  };
  return {
    $queryRaw: async () => [{ plan: store.plan }],
    entitlementEvent: { findMany: async () => [] },
    company: { count: async ({ where }: any) => (t.company ?? []).filter((c) => c.tenantId === where.tenantId).length, create: insert("company") },
    agent: { create: insert("agent") },
    pipeline: { create: insert("pipeline") },
    memoryItem: { create: insert("memoryItem") },
    user: { findFirst: async () => null },
    companyMember: { upsert: async () => ({}) },
    companyTemplate: {
      update: async ({ data }: any) => {
        store.template!.installCount += data.installCount.increment;
      },
    },
    templateInstall: { create: insert("templateInstall") },
    activityLog: { create: insert("activityLog") },
  };
}

vi.mock("../../../lib/db", () => ({
  prisma: { companyTemplate: { findUnique: async () => store.template } },
  tenantTx: async (fn: (tx: any) => Promise<unknown>) => {
    store.txCount++;
    return fn(fakeTx());
  },
}));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { installTemplate } from "../../templates/templates.service";
import { toMicroAppManifest } from "../../templates/micro-app-manifest";
import {
  buildPilotPackage,
  pilotScenarioSnapshot,
  validatePilotPackage,
  PILOT_SCENARIO_ID,
  PILOT_SCENARIO_COUNT,
  PILOT_SCENARIO_SEED,
  PILOT_SCENARIO_VERSION,
} from "../pilot-scenario";
import { generateSyntheticData } from "../synthetic-data";

const TENANT = "tenant-e2e-a";
const OTHER = "tenant-e2e-b";

/** Test-yerel "run": materialise edilmiş boru hattı satırlarını sırayla koşar, taslak üretir. */
function runDraft(tenantId: string, companyId: string) {
  const company = store.tables.company.find((c) => c.id === companyId)!;
  expect(company.tenantId).toBe(tenantId);
  const agents = store.tables.agent.filter((a) => a.companyId === companyId);
  const pipeline = store.tables.pipeline.find((p) => p.companyId === companyId)!;
  const records = generateSyntheticData({ seed: PILOT_SCENARIO_SEED, count: PILOT_SCENARIO_COUNT, kind: "customer" });
  const log: { tenantId: string; step: string; agentRole: string; agentId: string }[] = [];
  const steps = [...(pipeline.steps as any[])].sort((a, b) => a.order - b.order);
  for (const s of steps) {
    const agent = agents.find((a) => a.role === s.agentRole)!;
    log.push({ tenantId, step: s.name, agentRole: s.agentRole, agentId: agent.id });
  }
  const draft = `Haftalık özet: ${records.length} müşteri kaydı\n` + records.map((r) => `- ${r.name} (${r.company})`).join("\n");
  return { log, draft, records };
}

beforeEach(() => {
  store.tables = {};
  store.txCount = 0;
  store.seq = 0;
  store.plan = "TEAM";
  store.template = {
    id: "tpl-pilot",
    visibility: "PUBLIC",
    isApproved: true,
    pricing: "FREE",
    publisherTenantId: "publisher",
    installCount: 0,
    snapshot: pilotScenarioSnapshot(),
  };
});

describe("pilot e2e: install → materialise → run taslağı", () => {
  it("install: şirket/ajan/boru hattı sayıları senaryo sabitinden gelir, hepsi tenant'a bağlı", async () => {
    const snap = pilotScenarioSnapshot();
    const { companyId, slug } = await installTemplate("tpl-pilot", TENANT, {}, undefined);
    const t = store.tables;
    expect(slug).toMatch(/^haftal.*-[a-z0-9]+$/);
    expect(t.company).toHaveLength(1);
    expect(t.company[0]).toMatchObject({ id: companyId, tenantId: TENANT, status: "DRAFT", name: snap.name });
    expect(t.agent).toHaveLength(snap.agents.length);
    expect(t.pipeline).toHaveLength(snap.pipelines.length);
    expect(t.memoryItem ?? []).toHaveLength(snap.memorySeeds.length);
    expect(t.agent.every((a) => a.companyId === companyId)).toBe(true);
    expect((t.pipeline[0].steps as unknown[]).length).toBe(snap.pipelines[0].steps.length);
    expect(t.pipeline[0]).toMatchObject({ trigger: snap.pipelines[0].trigger, schedule: snap.pipelines[0].schedule, pipelineType: "SEQUENTIAL" });
    expect(t.templateInstall).toEqual([expect.objectContaining({ templateId: "tpl-pilot", tenantId: TENANT, installedCompanyId: companyId })]);
    expect(t.activityLog).toEqual([expect.objectContaining({ tenantId: TENANT, action: "template.install", resourceId: companyId })]);
    expect(store.template!.installCount).toBe(1);
    expect(store.txCount).toBe(1); // tek transaction
  });

  it("run: adım sırası ve sayısı sabitle eşit; her adımda tenantId; taslak sentetik veriyle üretilir", async () => {
    const snap = pilotScenarioSnapshot();
    const { companyId } = await installTemplate("tpl-pilot", TENANT);
    const { log, draft, records } = runDraft(TENANT, companyId);
    expect(log).toHaveLength(snap.pipelines[0].steps.length);
    expect((snap.pipelines[0].steps as any[]).map((s) => s.name)).toEqual(log.map((l) => l.step));
    expect(log.every((l) => l.tenantId === TENANT)).toBe(true);
    // her adımın ajanı bu şirketin ajanı
    const ownIds = new Set(store.tables.agent.map((a) => a.id));
    expect(log.every((l) => ownIds.has(l.agentId))).toBe(true);
    expect(records).toHaveLength(PILOT_SCENARIO_COUNT);
    expect(draft.split("\n")).toHaveLength(1 + PILOT_SCENARIO_COUNT);
    expect(draft).toContain(records[0].name);
    // sabit seed: ikinci üretim bayt-bayt aynı
    expect(runDraft(TENANT, companyId).draft).toBe(draft);
  });

  it("pilot paket: manifest senaryo sabitiyle eşit, 12 sentetik kayıt, doğrulamadan geçer", () => {
    const pkg = buildPilotPackage();
    const snap = pilotScenarioSnapshot();
    expect(() => validatePilotPackage(pkg)).not.toThrow();
    expect(pkg.manifest.syntheticDataRef).toBe(PILOT_SCENARIO_ID);
    expect(pkg.manifest.version).toBe(PILOT_SCENARIO_VERSION);
    expect(pkg.syntheticData).toHaveLength(PILOT_SCENARIO_COUNT);
    expect(pkg.manifest.agents).toHaveLength(snap.agents.length);
    expect(pkg.manifest.pipelines[0].stepNames).toHaveLength(snap.pipelines[0].steps.length);
    expect(JSON.stringify(buildPilotPackage())).toBe(JSON.stringify(buildPilotPackage()));
  });

  it("materialise çıktısında sır/ham içerik yok: manifest ve satırlar", async () => {
    await installTemplate("tpl-pilot", TENANT);
    const manifestText = JSON.stringify(toMicroAppManifest(pilotScenarioSnapshot(), { version: PILOT_SCENARIO_VERSION, syntheticDataRef: PILOT_SCENARIO_ID }));
    for (const trap of ["systemPrompt", "tenantId", "companyId", "http", "@", "sk-", "Bearer", "apiKey", "password"]) {
      expect(manifestText, trap).not.toContain(trap);
    }
    const rowsText = JSON.stringify([store.tables.company, store.tables.pipeline, store.tables.activityLog, store.tables.templateInstall]);
    for (const trap of ["sk-", "Bearer", "apiKey", "password", "secret", "-----BEGIN", "http"]) {
      expect(rowsText, trap).not.toContain(trap);
    }
    // araç girdileri: yalnız ad/bağlayıcı/kapsam etiketi, kimlik bilgisi alanı yok
    for (const a of store.tables.agent) {
      for (const tool of a.tools as Row[]) expect(Object.keys(tool).every((k) => ["name", "connector", "scopes"].includes(k))).toBe(true);
    }
  });

  it("idempotent değil (mevcut davranış): ikinci install ikinci şirket yaratır, installCount 2, slug farklı olabilir", async () => {
    const a = await installTemplate("tpl-pilot", TENANT);
    const b = await installTemplate("tpl-pilot", TENANT);
    expect(b.companyId).not.toBe(a.companyId);
    expect(store.tables.company).toHaveLength(2);
    expect(store.tables.templateInstall).toHaveLength(2);
    expect(store.template!.installCount).toBe(2);
    const snap = pilotScenarioSnapshot();
    expect(store.tables.agent).toHaveLength(2 * snap.agents.length);
    // ajan kimlikleri iki şirkette ayrı
    expect(new Set(store.tables.agent.map((x) => x.id)).size).toBe(store.tables.agent.length);
  });

  it("tenant izolasyonu: farklı tenant'ın install'ı ayrı şirket; run başka tenant'a sızmaz", async () => {
    const a = await installTemplate("tpl-pilot", TENANT);
    const b = await installTemplate("tpl-pilot", OTHER);
    expect(store.tables.company.find((c) => c.id === a.companyId)!.tenantId).toBe(TENANT);
    expect(store.tables.company.find((c) => c.id === b.companyId)!.tenantId).toBe(OTHER);
    expect(runDraft(OTHER, b.companyId).log.every((l) => l.tenantId === OTHER)).toBe(true);
    expect(store.tables.templateInstall.map((i) => i.tenantId).sort()).toEqual([OTHER, TENANT].sort());
  });

  it("kapasite: MANUAL_REVIEW planında 402 ve hiçbir satır yazılmaz", async () => {
    store.plan = "MANUAL_REVIEW";
    await expect(installTemplate("tpl-pilot", TENANT)).rejects.toMatchObject({ statusCode: 402 });
    expect(store.tables.company ?? []).toHaveLength(0);
    expect(store.template!.installCount).toBe(0);
  });

  it("onaysız PUBLIC şablon ve başkasının PRIVATE şablonu 404; hiçbir yazma olmaz", async () => {
    store.template!.isApproved = false;
    await expect(installTemplate("tpl-pilot", TENANT)).rejects.toMatchObject({ statusCode: 404 });
    store.template = { ...store.template!, visibility: "PRIVATE", isApproved: true };
    await expect(installTemplate("tpl-pilot", TENANT)).rejects.toMatchObject({ statusCode: 404 });
    expect(store.txCount).toBe(0);
  });
});
