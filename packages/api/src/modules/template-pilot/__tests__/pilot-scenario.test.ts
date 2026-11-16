import { describe, it, expect } from "vitest";
import {
  buildPilotPackage,
  pilotScenarioSnapshot,
  validatePilotPackage,
  PILOT_SCENARIO_ID,
  PILOT_SCENARIO_COUNT,
  PILOT_SCENARIO_SEED,
  PilotValidationError,
  pilotDataAllowlistSizes,
} from "../pilot-scenario";
import { generateSyntheticData } from "../synthetic-data";
import { microAppManifestSchema } from "../../templates/micro-app-manifest";

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


  it("snapshot honestly documents the draft-only claim and the cron zone", () => {
    const s = pilotScenarioSnapshot();
    expect(s.description).toContain("gönderim eylemi istemez");
    expect(s.description).toContain("zorlama bağlayıcı kapsamına bağlıdır");
    expect(s.description).not.toMatch(/gönderim yoktur/);
  });

  it("derived data allowlist covers the generator's 20 brands and 8 task verbs", () => {
    expect(pilotDataAllowlistSizes()).toEqual({ brands: 20, verbs: 8 });
  });

  it("accepts every generator kind (customer / task / mixed) at the cap", () => {
    for (const kind of ["customer", "task", "mixed"] as const) {
      const pkg = { manifest: buildPilotPackage().manifest, syntheticData: generateSyntheticData({ seed: 9, count: 1000, kind }) };
      expect(() => validatePilotPackage(pkg), kind).not.toThrow();
    }
  });
});

const rule = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof PilotValidationError ? e.rule : `other:${(e as Error).message}`;
  }
  return undefined;
};
const mutate = (fn: (p: any) => void, count = 3) => {
  const p = clone(buildPilotPackage({ count })) as any;
  fn(p);
  return p;
};
const toolNames = (p: any) => p.manifest.agents[0].toolNames;

describe("manifest negatives: each is rejected by the intended rule", () => {
  it("wrong schemaVersion / extra manifest key / agent apiKey / missing manager -> manifest-schema", () => {
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.schemaVersion = "2"))))).toBe("manifest-schema");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.tenantId = "t-1"))))).toBe("manifest-schema");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.agents[0].apiKey = "x"))))).toBe("manifest-schema");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.pipelines[0].pipelineType = "HIERARCHICAL"))))).toBe("manifest-schema");
  });

  it.each([
    ["sk-live token", "sk-live-abcdef1234567890"],
    ["AWS key", "AKIAABCDEFGHIJKLMNOP"],
    ["12-digit PII run", "123456789012"],
    ["secret word", "secret_reader"],
  ])("secret/PII-like toolName (%s) -> manifest-secret, not schema or pin", (_l, name) => {
    const p = mutate((x) => toolNames(x).push(name));
    // the tool name is a schema-valid slug, so only the real secret rule can fire
    expect(buildSchemaOk(p)).toBe(true);
    expect(rule(() => validatePilotPackage(p))).toBe("manifest-secret");
  });

  it("URL or e-mail in name/description -> manifest-secret", () => {
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.description = "bkz https://x.example/a"))))).toBe("manifest-secret");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.name = "Ali ali@example.com"))))).toBe("manifest-secret");
  });

  it("extra scope gmail.send, extra connector, or swapped gmail.compose -> manifest-pin", () => {
    expect(rule(() => validatePilotPackage(mutate((p) => p.manifest.connectorRequests[0].scopes.push("gmail.send"))))).toBe("manifest-pin");
    expect(rule(() => validatePilotPackage(mutate((p) => p.manifest.connectorRequests.push({ provider: "slack", scopes: ["chat.write"] }))))).toBe("manifest-pin");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.connectorRequests[0].scopes = ["gmail.compose"]))))).toBe("manifest-pin");
  });

  it("changed name, extra agent tool, extra step, or foreign dataRef -> manifest-pin", () => {
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.name = "Başka iş"))))).toBe("manifest-pin");
    expect(rule(() => validatePilotPackage(mutate((p) => toolNames(p).push("extra_tool"))))).toBe("manifest-pin");
    expect(rule(() => validatePilotPackage(mutate((p) => p.manifest.pipelines[0].stepNames.push("Gönder"))))).toBe("manifest-pin");
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.syntheticDataRef = "baska-ref"))))).toBe("manifest-pin");
  });

  it("the null data ref (as the export endpoint emits) is accepted", () => {
    expect(rule(() => validatePilotPackage(mutate((p) => (p.manifest.syntheticDataRef = null))))).toBeUndefined();
  });
});

describe("data negatives (allowlist): each is rejected by the intended rule", () => {
  const bad = (field: string, value: unknown, idx = 0) => rule(() => validatePilotPackage(mutate((p) => (p.syntheticData[idx][field] = value))));

  it.each([
    "Sahte Ali Veli",
    "Sahte Müşteri 12345678901",
    "Sahte Müşteri 001 ali[at]example.com",
    "Sahte Müşteri 001 www.x.com",
    "Gerçek Kişi",
    "Sahte Müşteri 002", // number must equal the record position
  ])("name %j -> data-name", (name) => {
    expect(bad("name", name)).toBe("data-name");
  });

  it("task name with a card number instead of a known verb -> data-name", () => {
    const p = mutate((x) => {
      x.syntheticData[0].kind = "task";
      x.syntheticData[0].name = "Sahte Görev 001 - 4111 1111 1111 1111";
    });
    expect(rule(() => validatePilotPackage(p))).toBe("data-name");
  });

  it.each(["Sahte Ali Veli", "www.x.com", "TR33 0006 1005 1978 6457 8413 26", "ali@example.com", "Sahte Kurgu Atölyesi X"])(
    "company %j -> data-company",
    (c) => {
      expect(bad("company", c)).toBe("data-company");
    },
  );

  it("other field violations map to their own rule", () => {
    expect(bad("status", "bilinmiyor")).toBe("data-status");
    expect(bad("amount", 1e9)).toBe("data-amount");
    expect(bad("amount", 1.005)).toBe("data-amount");
    expect(bad("currency", "USD")).toBe("data-currency");
    expect(bad("date", "2026-02-31")).toBe("data-date");
    expect(bad("id", "syn-001", 1)).toBe("data-id");
    expect(bad("phone", "5551112233")).toBe("data-record-keys");
  });

  it("structurally wrong packages -> package-shape / data-shape", () => {
    expect(rule(() => validatePilotPackage(null))).toBe("package-shape");
    expect(rule(() => validatePilotPackage([]))).toBe("package-shape");
    expect(rule(() => validatePilotPackage({ manifest: buildPilotPackage().manifest }))).toBe("package-shape");
    expect(rule(() => validatePilotPackage({ ...buildPilotPackage(), extra: 1 }))).toBe("package-shape");
    expect(rule(() => validatePilotPackage({ ...buildPilotPackage(), syntheticData: "x" }))).toBe("data-shape");
  });

  it("validator is linear on hostile long input (no ReDoS)", () => {
    const t0 = Date.now();
    const p = mutate((x) => (x.syntheticData[0].name = "Sahte Müşteri 001" + " ".repeat(200_000) + "@"));
    expect(rule(() => validatePilotPackage(p))).toBe("data-name");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

function buildSchemaOk(p: any): boolean {
  return microAppManifestSchema.safeParse(p.manifest).success;
}
