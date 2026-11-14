import { describe, expect, it } from "vitest";
import {
  microAppManifestSchema,
  toMicroAppManifest,
} from "../micro-app-manifest";
import type { CompanyTemplateSnapshot } from "../templates.service";

const TRAPS = [
  "sk-live-SECRET123",
  "tenant-TRAP-1",
  "company-TRAP-2",
  "user-TRAP-3",
  "enc-blob-TRAP-4",
  "bearer-TRAP-5",
];

function snapshot(): CompanyTemplateSnapshot {
  return {
    name: "Acme Ops",
    description: "demo",
    primitives: { tenantId: TRAPS[1], companyId: TRAPS[2], apiKey: TRAPS[0] },
    agents: [
      {
        handle: "agent-9f8e7d",
        name: "Writer",
        role: "writer",
        systemPrompt: `use key ${TRAPS[0]}`,
        model: "claude-sonnet-5-5",
        maxTokens: 1024,
        tools: [
          "search",
          {
            name: "mail",
            connector: "gmail",
            scopes: ["read", "send"],
            token: TRAPS[5],
            apiKey: TRAPS[0],
            encryptedCredentials: TRAPS[4],
            userId: TRAPS[3],
          },
          { name: TRAPS[0], connector: TRAPS[0] },
        ],
      },
    ],
    pipelines: [
      {
        name: "Daily",
        trigger: "SCHEDULED",
        schedule: "0 9 * * *",
        pipelineType: "HIERARCHICAL",
        managerAgentHandle: "agent-9f8e7d",
        maxDelegationDepth: 2,
        steps: [{ name: "draft", agentId: TRAPS[3], secret: TRAPS[0] }],
        config: { tenantId: TRAPS[1], password: TRAPS[0] },
      },
    ],
    memorySeeds: [{ type: "SEMANTIC", content: TRAPS[0], metadata: { userId: TRAPS[3] } }],
  };
}

describe("toMicroAppManifest", () => {
  it("projects snapshot to a valid manifest", () => {
    const m = toMicroAppManifest(snapshot(), { version: "1.0.0", syntheticDataRef: "demo-set" });
    expect(microAppManifestSchema.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(m.pipelines[0].pipelineType).toBe("HIERARCHICAL");
    expect(m.agents[0].toolNames).toEqual(["search", "mail"]);
    expect(m.agents[0].handle).toBe("agent-1");
    expect(m.pipelines[0].managerAgentHandle).toBe("agent-1");
    expect(m.connectorRequests).toEqual([{ provider: "gmail", scopes: ["read", "send"] }]);
    expect(m.syntheticDataRef).toBe("demo-set");
  });

  it("drops credential/id fields and values (booby-trapped input)", () => {
    const out = JSON.stringify(toMicroAppManifest(snapshot(), { version: "1.0.0" }));
    for (const t of TRAPS) expect(out).not.toContain(t);
    for (const k of [/"token"/i, /secret/i, /apiKey/i, /encrypted/i, /password/i, /tenantId/i, /companyId/i, /userId/i, /systemPrompt/i]) {
      expect(out).not.toMatch(k);
    }
  });

  it("is pure and deterministic across random handles", () => {
    const a = snapshot();
    const b = snapshot();
    b.agents[0].handle = "agent-000000";
    b.pipelines[0].managerAgentHandle = "agent-000000";
    const before = JSON.stringify(a);
    const m1 = toMicroAppManifest(a, { version: "1.0.0" });
    expect(JSON.stringify(a)).toBe(before);
    expect(toMicroAppManifest(a, { version: "1.0.0" })).toEqual(m1);
    expect(toMicroAppManifest(b, { version: "1.0.0" })).toEqual(m1);
  });

  it("rejects invalid version", () => {
    expect(() => toMicroAppManifest(snapshot(), { version: "abc" })).toThrow();
  });
});

describe("microAppManifestSchema validation", () => {
  const valid = () => toMicroAppManifest(snapshot(), { version: "1.2.3" });

  it("rejects missing field", () => {
    const { agents: _a, ...rest } = valid();
    expect(microAppManifestSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects wrong type", () => {
    expect(microAppManifestSchema.safeParse({ ...valid(), agents: "x" }).success).toBe(false);
    expect(microAppManifestSchema.safeParse({ ...valid(), name: 5 }).success).toBe(false);
  });
  it("rejects unknown keys at every level", () => {
    const m = valid();
    expect(microAppManifestSchema.safeParse({ ...m, apiKey: "x" }).success).toBe(false);
    expect(
      microAppManifestSchema.safeParse({ ...m, agents: [{ ...m.agents[0], tenantId: "t" }] }).success,
    ).toBe(false);
    expect(
      microAppManifestSchema.safeParse({
        ...m,
        connectorRequests: [{ provider: "gmail", scopes: [], token: "x" }],
      }).success,
    ).toBe(false);
  });
  it("rejects incompatible schema version", () => {
    expect(microAppManifestSchema.safeParse({ ...valid(), schemaVersion: "2" }).success).toBe(false);
  });
  it("rejects dangling manager handle", () => {
    const m = valid();
    m.pipelines[0].managerAgentHandle = "agent-99";
    expect(microAppManifestSchema.safeParse(m).success).toBe(false);
  });
});
