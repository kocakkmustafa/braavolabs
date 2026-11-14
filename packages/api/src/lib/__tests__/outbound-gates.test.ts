import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  isDeployMergeTool,
  OUTBOUND_DISABLED_CODES,
  OUTBOUND_GATE_ENV,
  assertOutboundFeatureEnabled,
  disabledFeatureForTool,
  isOutboundFeatureEnabled,
  type OutboundFeature,
} from "../outbound-gates";
import { AppError, errorHandler } from "../../middleware/error";

const FEATURES: OutboundFeature[] = ["email", "outreach", "voice", "deploy_merge"];

afterEach(() => { vi.unstubAllEnvs(); });

describe("B-06 outbound gates", () => {
  it("uses the documented env names and stable error codes", () => {
    expect(OUTBOUND_GATE_ENV).toEqual({
      email: "OUTBOUND_EMAIL_ENABLED",
      outreach: "OUTREACH_SEQUENCES_ENABLED",
      voice: "VOICE_AGENT_ENABLED",
      deploy_merge: "DEPLOY_MERGE_TOOLS_ENABLED",
    });
    expect(OUTBOUND_DISABLED_CODES).toEqual({
      email: "EMAIL_SENDING_DISABLED",
      outreach: "OUTREACH_SEQUENCES_DISABLED",
      voice: "VOICE_AGENT_DISABLED",
      deploy_merge: "DEPLOY_MERGE_TOOLS_DISABLED",
    });
  });

  it.each(FEATURES)("%s is OFF when its flag is unset (production default)", (feature) => {
    for (const name of Object.values(OUTBOUND_GATE_ENV)) {
      vi.stubEnv(name, "x");
      delete process.env[name];
    }
    expect(isOutboundFeatureEnabled(feature)).toBe(false);
    expect(() => assertOutboundFeatureEnabled(feature)).toThrow(AppError);
  });

  it.each(FEATURES)("%s enables only for the literal \"true\"", (feature) => {
    for (const value of ["", "false", "1", "yes", "TRUE", " true"]) {
      vi.stubEnv(OUTBOUND_GATE_ENV[feature], value);
      expect(isOutboundFeatureEnabled(feature)).toBe(false);
    }
    vi.stubEnv(OUTBOUND_GATE_ENV[feature], "true");
    expect(isOutboundFeatureEnabled(feature)).toBe(true);
    expect(() => assertOutboundFeatureEnabled(feature)).not.toThrow();
  });

  it("flags are independent", () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    expect(isOutboundFeatureEnabled("email")).toBe(true);
    expect(isOutboundFeatureEnabled("outreach")).toBe(false);
    expect(isOutboundFeatureEnabled("voice")).toBe(false);
  });

  it("disabled feature serializes as 422 with a top-level code", () => {
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    let thrown: unknown;
    try { assertOutboundFeatureEnabled("voice"); } catch (err) { thrown = err; }
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    errorHandler(thrown as Error, {} as any, res as any, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      error: "Voice agent calls are temporarily unavailable.",
      details: undefined,
      code: "VOICE_AGENT_DISABLED",
    });
  });

  it("errors without a code keep the previous response shape", () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    errorHandler(new AppError(404, "Draft not found"), {} as any, res as any, vi.fn());
    expect(json).toHaveBeenCalledWith({ error: "Draft not found", details: undefined });
  });

  it("maps outbound agent tools to their gates", () => {
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
    vi.stubEnv("VOICE_AGENT_ENABLED", "false");
    expect(disabledFeatureForTool("make_outbound_call")).toBe("voice");
    expect(disabledFeatureForTool("email_send_sequence")).toBe("outreach");
    expect(disabledFeatureForTool("web_search")).toBeNull();

    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
    expect(disabledFeatureForTool("email_send_sequence")).toBe("email");

    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    vi.stubEnv("VOICE_AGENT_ENABLED", "true");
    expect(disabledFeatureForTool("email_send_sequence")).toBeNull();
    expect(disabledFeatureForTool("make_outbound_call")).toBeNull();
  });

  it("classifies deploy / merge tools regardless of case, alias or separator", () => {
    for (const n of ["deploy", "DEPLOY", "DeployApp", "github__merge_pull_request", "vercel.deployments-create", "mergePR", "deployprod", "rollback", "Release",
      "D3PL0Y", "d3ploy", "automerge_pr", "PRMerge", "squashmerge", "prmerge", "fastforwardmerge", "deployment_status", "m3rg3_pr",
      "mer_ge_pr", "mer.ge", "automergepr", "squashmergepr"]) {
      expect(isDeployMergeTool(n), n).toBe(true);
    }
    for (const n of ["web_search", "get_github_pr_status", "get_pr_mergeable", "emergency_lookup", "emerge", "crm_create_contact", "customer_get_orders", "customer_gender"]) {
      expect(isDeployMergeTool(n), n).toBe(false);
    }
    expect(isDeployMergeTool("run", "Deploys the app to production")).toBe(true);
    expect(isDeployMergeTool("run", "Runs a report")).toBe(false);
  });

  it("invisible characters cannot split the verb (ZWSP, soft hyphen, combining mark)", () => {
    for (const n of ["mer\u200bge", "mer\u00adge_pr", "dep\u200dloy", "de\u0301ploy", "mer\u2060ge"]) {
      expect(isDeployMergeTool(n), JSON.stringify(n)).toBe(true);
    }
  });

  it("homoglyph names: fold-to-verb and script-mixing both block (fail-closed arms)", () => {
    // Script mixing: Cyrillic e + Latin letters in one token (mixed-script arm).
    expect(isDeployMergeTool("d\u0435ploy")).toBe(true);
    expect(isDeployMergeTool("d\u0435\u0440loy")).toBe(true);
    expect(isDeployMergeTool("m\u0435rge_pr")).toBe(true);
    // Greek omicron mixed with Latin.
    expect(isDeployMergeTool("depl\u03bfy")).toBe(true);
    expect(isDeployMergeTool("m\u03b5rge")).toBe(true);
    // Single-script name whose letters ALL fold to the verb (fold-to-verb arm), no Latin ASCII letter.
    expect(isDeployMergeTool("\u0501\u0435\u0440\u04cf\u043e\u0443")).toBe(true);
    // Cyrillic merge look-alike entirely in Cyrillic homoglyphs is not constructible (no Cyrillic g), so mixed arm covers it.
  });

  it("single-script non-Latin names are NOT blocked (production default, flag off)", () => {
    for (const n of ["g\u00fcnl\u00fck_raporu", "rapor_\u00f6zeti", "\u0627\u0644\u062a\u0642\u0631\u064a\u0631_\u0627\u0644\u064a\u0648\u0645\u064a", "\u65e5\u62a5\u751f\u6210", "\u043e\u0442\u0447\u0435\u0442_\u0434\u043d\u044f", "\u0130\u015fletme_\u00f6zeti"]) {
      expect(isDeployMergeTool(n), n).toBe(false);
    }
  });

  it("non-string input fails closed without throwing", () => {
    for (const bad of [42, {}, [], null, undefined]) {
      expect(() => isDeployMergeTool(bad as any)).not.toThrow();
      expect(isDeployMergeTool(bad as any), String(bad)).toBe(true);
    }
    for (const bad of [42, {}, null]) {
      expect(isDeployMergeTool("list_items", bad as any), String(bad)).toBe(true);
    }
    expect(isDeployMergeTool("list_items", undefined)).toBe(false);
    expect(disabledFeatureForTool("x__y", { dynamic: true, remoteName: null, remoteDescription: undefined })).toBe("deploy_merge");
  });

  it("classification is linear-time on adversarial input", () => {
    const inputs = ["A".repeat(200000), "aA".repeat(100000), "deploy ".repeat(100000), "AB".repeat(100000) + "c"];
    for (const x of inputs) {
      for (const [n, d] of [[x.slice(0, 500), undefined], ["list_items", x]] as const) {
        const t0 = performance.now();
        isDeployMergeTool(n, d);
        expect(performance.now() - t0).toBeLessThan(500);
      }
    }
    const t1 = performance.now();
    expect(isDeployMergeTool("A".repeat(200000))).toBe(true); // over the name cap: fail closed, instantly
    expect(performance.now() - t1).toBeLessThan(200);
  });

  it("scans the WHOLE description: verb buried in the middle, split at window edges, over caps", () => {
    const pad = "lorem ipsum ".repeat(8334); // ~100k chars
    expect(isDeployMergeTool("run", pad + "deploy" + pad)).toBe(true);
    expect(isDeployMergeTool("run", pad + pad)).toBe(false);
    // Verb straddling every window edge position near the 4000/64 boundary.
    for (let k = 3900; k < 4010; k += 7) {
      const text = "x".repeat(k) + "deploy" + "x".repeat(9000);
      expect(isDeployMergeTool("run", text), String(k)).toBe(true);
      const j = "x".repeat(k) + "mer_ge_pr" + "x".repeat(9000);
      expect(isDeployMergeTool("run", j), "j" + k).toBe(true);
    }
    // 300 000 chars (over the 256 KiB cap) fail closed; 1 MB fails fast.
    expect(isDeployMergeTool("run", "a ".repeat(150000))).toBe(true);
    const t0 = performance.now();
    expect(isDeployMergeTool("run", "q".repeat(1024 * 1024))).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
    // Just under the cap is scanned (not blindly blocked) and stays linear.
    const t1 = performance.now();
    expect(isDeployMergeTool("run", "a ".repeat(120000))).toBe(false);
    expect(performance.now() - t1).toBeLessThan(2000);
  });

  it("separator-padded verbs are caught at every window-edge position", () => {
    const pad = (k: number) => "x ".repeat(Math.ceil(k / 2)).slice(0, k);
    for (const verb of ["d_e_p_l_o_y", "d e p l o y", "m-e-r-g-e", "d___e___p_l_o_y"]) {
      for (let k = 3880; k <= 4120; k += 3) {
        const text = pad(k) + " " + verb + " " + pad(100000);
        expect(isDeployMergeTool("run", text), verb + "@" + k).toBe(true);
      }
    }
    expect(isDeployMergeTool("run", pad(100000))).toBe(false);
  });

  it("non-alphanumeric leet keys ($ @) are folded before separators collapse", () => {
    for (const n of ["relea$e", "rele@se", "rollb@ck", "d3pl0y$", "d3$pl0y".replace("$", "_"), "m3rg3@pr", "$deploy"]) {
      expect(isDeployMergeTool(n), n).toBe(true);
    }
    expect(isDeployMergeTool("run", "then rele@se it")).toBe(false); // description: release is name-only
    expect(isDeployMergeTool("run", "then d3pl0y$ it")).toBe(true);
  });

  it("a very long separator run does not hide or slow the scan", () => {
    const t0 = performance.now();
    expect(isDeployMergeTool("run", "d" + "_".repeat(50000) + "e_p_l_o_y")).toBe(true);
    expect(isDeployMergeTool("run", "x" + "_".repeat(50000) + "deploy")).toBe(true);
    expect(isDeployMergeTool("run", "_".repeat(200000))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("NFKC expansion cannot dodge the size caps (fail closed, fast)", () => {
    const x = "\ufdfa"; // expands 18x under NFKC
    const t0 = performance.now();
    expect(isDeployMergeTool("run", x.repeat(100000))).toBe(true); // description
    expect(isDeployMergeTool(x.repeat(40))).toBe(true); // name: 40 raw chars -> 720 folded
    expect(isDeployMergeTool(x.repeat(20))).toBe(false); // 360 folded, under the cap, not a verb
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("names over 512 chars fail closed", () => {
    expect(isDeployMergeTool("a".repeat(513))).toBe(true);
    expect(isDeployMergeTool("a".repeat(512))).toBe(false);
  });

  it("deploy/merge gate: off by default, on only for the literal true; connector description counts", () => {
    vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "");
    expect(disabledFeatureForTool("gh__MERGE_pr", { dynamic: true })).toBe("deploy_merge");
    expect(disabledFeatureForTool("x__run", { dynamic: true, remoteDescription: "Merge the branch" })).toBe("deploy_merge");
    expect(disabledFeatureForTool("web_search")).toBeNull();
    vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "true");
    expect(disabledFeatureForTool("gh__merge_pr", { dynamic: true })).toBeNull();
  });

  it("a deploy-looking connector slug/name taints all its tools; look-alike connectors do not", () => {
    vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "");
    const base = { dynamic: true, remoteName: "list_items", remoteDescription: "Lists items" } as const;
    expect(disabledFeatureForTool("mcp_deployer_list_items", { ...base, connectorSlug: "deployer", connectorName: "Deployer" })).toBe("deploy_merge");
    expect(disabledFeatureForTool("mcp_x_list_items", { ...base, connectorSlug: "x", connectorName: "Deploy Bot" })).toBe("deploy_merge");
    expect(disabledFeatureForTool("mcp_m_list_items", { ...base, connectorSlug: "mergeable-tools", connectorName: "Mergeable Tools" })).toBeNull();
    expect(disabledFeatureForTool("mcp_e_list_items", { ...base, connectorSlug: "emergency-contacts", connectorName: "Emergency Contacts" })).toBeNull();
  });
});
