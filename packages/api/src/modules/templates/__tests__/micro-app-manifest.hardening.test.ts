import { describe, expect, it } from "vitest";
import { microAppManifestSchema, toMicroAppManifest } from "../micro-app-manifest";
import type { CompanyTemplateSnapshot } from "../templates.service";

function snapshot(): CompanyTemplateSnapshot {
  return {
    name: "Acme",
    description: "demo",
    primitives: {},
    agents: [
      {
        handle: "agent-aaaaaa",
        name: "Writer",
        role: "writer",
        systemPrompt: "p",
        model: "claude-sonnet-5-5",
        maxTokens: 1024,
        tools: ["search"],
      },
    ],
    pipelines: [
      {
        name: "Daily",
        trigger: "SCHEDULED",
        schedule: "0 9 * * *",
        pipelineType: "HIERARCHICAL",
        managerAgentHandle: "agent-aaaaaa",
        maxDelegationDepth: 2,
        steps: [{ name: "draft" }],
        config: {},
      },
    ],
    memorySeeds: [],
  };
}

const REALISTIC = [
  "eyJhbGciOiJIUzI1NiJ9.payload.sig",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "AKIAABCDEFGHIJKLMNOP",
  "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  "cjld2cjxh0000qzrmn831i7rn",
  "123e4567-e89b-12d3-a456-426614174000",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  "x-sk-abc123",
  "xoxb-1234-abcd",
];

function withTool(entry: unknown): CompanyTemplateSnapshot {
  const s = snapshot();
  s.agents[0].tools = [entry];
  return s;
}

describe("manifest hardening", () => {
  it("T1: credential-like tool/connector/scope names are dropped", () => {
    for (const trap of REALISTIC) {
      const out = toMicroAppManifest(
        withTool({ name: trap, connector: trap, scopes: [trap, "https://evil.test/?token=abc"] }),
        { version: "1.0.0" },
      );
      expect(out.agents[0].toolNames).toEqual([]);
      expect(out.connectorRequests).toEqual([]);
      expect(JSON.stringify(out)).not.toContain(trap);
    }
    const url = toMicroAppManifest(withTool({ name: "t", connector: "https://x.test/cb?token=1" }), {
      version: "1.0.0",
    });
    expect(url.connectorRequests).toEqual([]);
  });

  it("keeps legitimate simple names such as token_counter", () => {
    const out = toMicroAppManifest(
      withTool({ name: "token_counter", connector: "gmail", scopes: ["gmail.readonly"] }),
      { version: "1.0.0" },
    );
    expect(out.agents[0].toolNames).toEqual(["token_counter"]);
    expect(out.connectorRequests).toEqual([{ provider: "gmail", scopes: ["gmail.readonly"] }]);
  });

  it("T2: free-text traps are redacted, not rejected", () => {
    const s = snapshot();
    s.name = "Acme ops@acme.test";
    s.agents[0].role = "mail bob@example.com";
    s.agents[0].model = "https://llm.internal.test/v1/sk-live-SECRET123";
    s.pipelines[0].steps = [{ name: "step sk-live-SECRET123 4111111111111111" }];
    s.pipelines[0].description = "call https://hooks.test/x?token=zzz now";
    const out = toMicroAppManifest(s, { version: "1.0.0-AKIAABCDEFGHIJKLMNOP" });
    const json = JSON.stringify(out);
    for (const bad of [
      "bob@example.com",
      "ops@acme.test",
      "llm.internal",
      "SECRET123",
      "4111111111111111",
      "hooks.test",
      "AKIA",
    ]) {
      expect(json).not.toContain(bad);
    }
    expect(out.agents[0].model).toContain("[redacted]");
    expect(out.version).toBe("1.0.0");
  });

  it("T4: caps lists and does not throw on oversized input", () => {
    const base = snapshot();
    const s = snapshot();
    s.agents = Array.from({ length: 80 }, (_, i) => ({
      ...base.agents[0],
      handle: `h${i}`,
      maxTokens: 10 ** 12,
      tools: Array.from({ length: 150 }, (_, j) => ({
        name: `tool-${i}-${j}`,
        connector: `prov-${i}-${j}`,
        scopes: Array.from({ length: 80 }, (_, k) => `s${k}`),
      })),
    }));
    s.pipelines = Array.from({ length: 70 }, () => ({
      ...base.pipelines[0],
      managerAgentHandle: "h79", // beyond the 50-agent cut: unknown manager
      maxDelegationDepth: 999,
      steps: Array.from({ length: 300 }, (_, i) => ({ name: `s${i}` })),
    }));
    const m = toMicroAppManifest(s, { version: "1.0.0" });
    expect(m.agents).toHaveLength(50);
    expect(m.pipelines).toHaveLength(50);
    expect(m.connectorRequests).toHaveLength(50);
    expect(m.connectorRequests[0].scopes.length).toBeLessThanOrEqual(50);
    expect(m.agents[0].toolNames).toHaveLength(100);
    expect(m.agents[0].maxTokens).toBe(1_000_000);
    expect(m.pipelines[0].stepNames).toHaveLength(100);
    expect(m.pipelines[0].maxDelegationDepth).toBe(10);
    expect(m.pipelines[0].pipelineType).toBe("SEQUENTIAL");
    expect(m.pipelines[0].managerAgentHandle).toBeUndefined();
  });

  it("T4: HIERARCHICAL with unknown manager degrades; schema demands a manager", () => {
    const s = snapshot();
    s.pipelines[0].managerAgentHandle = "nope";
    expect(toMicroAppManifest(s, { version: "1.0.0" }).pipelines[0].pipelineType).toBe("SEQUENTIAL");
    const m = toMicroAppManifest(snapshot(), { version: "1.0.0" });
    const bad = { ...m, pipelines: [{ ...m.pipelines[0], managerAgentHandle: undefined }] };
    expect(microAppManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("T1b: legitimate connector keeps good scopes, drops trap scopes", () => {
    const traps = [
      "eyJhbGciOiJIUzI1NiJ9.payload.sig",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    const out = toMicroAppManifest(
      withTool({ name: "mail", connector: "gmail", scopes: ["read", ...traps, "send"] }),
      { version: "1.0.0" },
    );
    expect(out.connectorRequests).toEqual([{ provider: "gmail", scopes: ["read", "send"] }]);
    for (const t of traps) expect(JSON.stringify(out)).not.toContain(t);
  });

  it("ReDoS: 200k-char hostile free text is fast and schema-valid", () => {
    for (const unit of ["a", "a-", "a@", "sk-", "1", "a/"]) {
      const big = unit.repeat(200_000);
      const s = snapshot();
      s.name = big;
      s.description = big;
      s.agents[0].name = big;
      s.agents[0].role = big;
      s.agents[0].model = big;
      s.pipelines[0].name = big;
      s.pipelines[0].description = big;
      s.pipelines[0].schedule = big;
      s.pipelines[0].steps = [{ name: big }];
      const t0 = performance.now();
      const m = toMicroAppManifest(s, { version: "1.0.0" });
      expect(performance.now() - t0).toBeLessThan(200);
      expect(microAppManifestSchema.safeParse(m).success).toBe(true);
    }
  });

  it("padding cannot push a secret across the cut line (leaves no prefix behind)", () => {
    const rnd = "Zq9Xw3Lm7Rt2Vb8Nc4Hd6Jf1Kg5Ps0Yu3Ae7Ox";
    const secrets = ["sk-live-" + rnd, "ghp_" + rnd, "AKIAZQ9XW3LM7RT2VB8N", "eyJ" + rnd];
    const leftovers = ["sk-l", "ghp_", "AKIA", "eyJ"];
    const pads = [" ", "\t", "\n", " \t\n"];
    const MAX = 200; // agent name limit
    for (const secret of secrets) {
      for (const unit of pads) {
        for (let n = MAX - 70; n <= MAX + 70; n++) {
          const pad = unit.repeat(n);
          for (const input of [pad + secret, "x" + pad + secret, "a".repeat(n) + " " + secret]) {
            const s = snapshot();
            s.agents[0].name = input;
            s.pipelines[0].description = input;
            s.pipelines[0].steps = [{ name: input }];
            const json = JSON.stringify(toMicroAppManifest(s, { version: "1.0.0" }));
            for (const l of leftovers) expect(json).not.toContain(l);
            for (let i = 0; i + 6 <= rnd.length; i++) expect(json).not.toContain(rnd.slice(i, i + 6));
          }
        }
      }
    }
    // 5000-space padding in front of a secret
    const s = snapshot();
    s.agents[0].role = " ".repeat(5000) + "sk-live-" + rnd;
    const m = toMicroAppManifest(s, { version: "1.0.0" });
    expect(JSON.stringify(m)).not.toContain("sk-l");
    expect(m.agents[0].role).toBe("[redacted]");
  });

  it("malformed snapshots never throw and yield a valid manifest", () => {
    const bad: unknown[] = [
      {},
      null,
      { agents: null, pipelines: null, description: null },
      { pipelines: [{ trigger: "CRON", pipelineType: 42 }] },
      { pipelines: [{ trigger: undefined, pipelineType: undefined, name: 5, steps: "x" }] },
      { agents: [null, 3, "x", {}], pipelines: [null, [], 7] },
    ];
    for (const b of bad) {
      const m = toMicroAppManifest(b as CompanyTemplateSnapshot, { version: "1.0.0" });
      expect(microAppManifestSchema.safeParse(m).success).toBe(true);
    }
    const base = snapshot();
    const m = toMicroAppManifest(
      {
        ...base,
        pipelines: [{ ...base.pipelines[0], trigger: "CRON" as never, pipelineType: 42 as never }],
      },
      { version: "1.0.0" },
    );
    expect(m.pipelines[0].trigger).toBe("MANUAL");
    expect(m.pipelines[0].pipelineType).toBe("SEQUENTIAL");
  });

  it("version: build metadata dropped, core kept", () => {
    expect(toMicroAppManifest(snapshot(), { version: "1.0.0+build.5" }).version).toBe("1.0.0");
    expect(toMicroAppManifest(snapshot(), { version: "1.0.0-rc.1+b" }).version).toBe("1.0.0-rc.1");
  });

  it("ordering is locale independent and the first 50 sorted providers survive", () => {
    const s = snapshot();
    s.agents[0].tools = Array.from({ length: 60 }, (_, i) => ({
      name: "t",
      connector: "p" + String(i).padStart(2, "0"),
      scopes: ["b", "B", "a"],
    }));
    const m = toMicroAppManifest(s, { version: "1.0.0" });
    expect(m.connectorRequests.map((c) => c.provider)).toEqual(
      Array.from({ length: 50 }, (_, i) => "p" + String(i).padStart(2, "0")),
    );
    expect(m.connectorRequests[0].scopes).toEqual(["B", "a", "b"]);
  });

  it("T4: empty agents, null description, malformed tools, duplicate handles", () => {
    const s = snapshot();
    s.agents = [];
    s.description = null;
    s.pipelines[0].managerAgentHandle = undefined;
    const m = toMicroAppManifest(s, { version: "1.0.0" });
    expect(m.agents).toEqual([]);
    expect(m.description).toBeNull();
    for (const tools of [null, undefined, "x", 5, [null, 3, {}, { name: 7 }]]) {
      const s2 = snapshot();
      s2.agents[0].tools = tools;
      expect(toMicroAppManifest(s2, { version: "1.0.0" }).agents[0].toolNames).toEqual([]);
    }
    const d = snapshot();
    d.agents.push({ ...d.agents[0], name: "Second" });
    const dm = toMicroAppManifest(d, { version: "1.0.0" });
    expect(dm.pipelines[0].managerAgentHandle).toBe("agent-1");
    expect(toMicroAppManifest(d, { version: "1.0.0" })).toEqual(dm);
  });
});
