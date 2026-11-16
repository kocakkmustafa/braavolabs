import { describe, it, expect } from "vitest";
import {
  buildPilotPackage,
  pilotScenarioSnapshot,
  validatePilotPackage,
  PILOT_SCENARIO_ID,
  PILOT_SCENARIO_COUNT,
  PILOT_SCENARIO_SEED,
} from "../pilot-scenario";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("pilot scenario: haftalık müşteri e-postası taslağı", () => {
  it("builds a package that passes the 07a manifest schema and data rules", () => {
    const pkg = buildPilotPackage();
    expect(() => validatePilotPackage(pkg)).not.toThrow();
    expect(pkg.manifest.schemaVersion).toBe("1");
    expect(pkg.manifest.syntheticDataRef).toBe(PILOT_SCENARIO_ID);
    expect(pkg.syntheticData).toHaveLength(PILOT_SCENARIO_COUNT);
    expect(pkg.syntheticData.every((r) => r.kind === "customer")).toBe(true);
  });

  it("scenario is fixed: 2 agents, 1 scheduled sequential pipeline, 3 steps, gmail drafts only", () => {
    const { manifest } = buildPilotPackage();
    expect(manifest.agents.map((a) => a.handle)).toEqual(["agent-1", "agent-2"]);
    expect(manifest.pipelines).toHaveLength(1);
    expect(manifest.pipelines[0]).toMatchObject({
      trigger: "SCHEDULED",
      schedule: "0 9 * * 1",
      pipelineType: "SEQUENTIAL",
      stepNames: ["Müşteri kayıtlarını oku", "Haftalık özeti çıkar", "E-posta taslağını yaz"],
    });
    expect(manifest.connectorRequests).toEqual([{ provider: "gmail", scopes: ["drafts.create"] }]);
  });

  it("same seed gives a byte-identical package; default seed is the fixed pilot seed", () => {
    const a = JSON.stringify(buildPilotPackage({ seed: 5, count: 8 }));
    const b = JSON.stringify(buildPilotPackage({ seed: 5, count: 8 }));
    expect(a).toBe(b);
    expect(JSON.stringify(buildPilotPackage())).toBe(
      JSON.stringify(buildPilotPackage({ seed: PILOT_SCENARIO_SEED, count: PILOT_SCENARIO_COUNT })),
    );
  });

  it("different seed changes the data but not the manifest", () => {
    const a = buildPilotPackage({ seed: 1 });
    const b = buildPilotPackage({ seed: 2 });
    expect(b.syntheticData).not.toEqual(a.syntheticData);
    expect(b.manifest).toEqual(a.manifest);
  });

  it("package carries no ids, credentials, URLs, e-mail or system prompts", () => {
    const text = JSON.stringify(buildPilotPackage({ seed: 77, count: 500 }));
    for (const trap of ["@", "http", "sk-", "apiKey", "systemPrompt", "tenantId", "companyId", "Bearer"]) {
      expect(text, trap).not.toContain(trap);
    }
    expect(text).not.toMatch(/\d{12,}/);
  });

  it("snapshot factory returns a fresh object each call", () => {
    const a = pilotScenarioSnapshot();
    a.agents[0].name = "mutated";
    expect(pilotScenarioSnapshot().agents[0].name).not.toBe("mutated");
  });

  it("rejects a manifest violation: wrong schemaVersion, extra key, missing manager", () => {
    const good = buildPilotPackage();
    const v = clone(good);
    (v.manifest as any).schemaVersion = "2";
    expect(() => validatePilotPackage(v)).toThrow();

    const extra = clone(good);
    (extra.manifest as any).tenantId = "t-1";
    expect(() => validatePilotPackage(extra)).toThrow();

    const noMgr = clone(good);
    noMgr.manifest.pipelines[0].pipelineType = "HIERARCHICAL";
    expect(() => validatePilotPackage(noMgr)).toThrow();

    const secret = clone(good);
    (secret.manifest.agents[0] as any).apiKey = "x";
    expect(() => validatePilotPackage(secret)).toThrow();
  });

  it("rejects a data violation: PII-looking, non-synthetic, bad status, duplicate id, extra key", () => {
    const base = buildPilotPackage({ count: 3 });
    const mutate = (fn: (p: any) => void) => {
      const p = clone(base) as any;
      fn(p);
      return p;
    };
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[0].name = "Sahte Ali ali@example.com")))).toThrow();
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[0].name = "Gerçek Kişi")))).toThrow();
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[0].status = "bilinmiyor")))).toThrow();
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[1].id = p.syntheticData[0].id)))).toThrow();
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[0].phone = "5551112233")))).toThrow();
    expect(() => validatePilotPackage(mutate((p) => (p.syntheticData[0].amount = 1e9)))).toThrow();
  });

  it("rejects structurally wrong packages", () => {
    expect(() => validatePilotPackage(null)).toThrow();
    expect(() => validatePilotPackage([])).toThrow();
    expect(() => validatePilotPackage({ manifest: buildPilotPackage().manifest })).toThrow();
    expect(() => validatePilotPackage({ ...buildPilotPackage(), extra: 1 })).toThrow();
  });
});
