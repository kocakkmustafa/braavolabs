/** Drift guards against the API's own copies until the API imports @braavo/core. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_PROVIDERS, LOCAL_PROVIDERS, PROVIDER_BASE_URLS } from "../providers";

const api = (path: string) => readFileSync(join(__dirname, "../../../api/src", path), "utf8");

describe("parity with packages/api", () => {
  it("relay protocol is byte-identical below the provenance header", () => {
    const core = readFileSync(join(__dirname, "../relay-protocol.ts"), "utf8").split("\n").slice(3).join("\n");
    expect(core).toBe(api("modules/relay/protocol.ts"));
  });

  it("provider list, local providers and base URLs match ai-client.ts", () => {
    const source = api("services/ai-client.ts");
    const union = /export type AIProviderType =([\s\S]*?);/.exec(source)![1];
    expect([...union.matchAll(/"([A-Z]+)"/g)].map(m => m[1])).toEqual([...AI_PROVIDERS]);
    const local = /LOCAL_PROVIDERS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(source)![1];
    expect([...local.matchAll(/"([A-Z]+)"/g)].map(m => m[1]).sort()).toEqual([...LOCAL_PROVIDERS].sort());
    const block = /PROVIDER_BASE_URLS[^=]*= \{([\s\S]*?)\};/.exec(source)![1];
    const urls = Object.fromEntries([...block.matchAll(/([A-Z]+):\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
    expect(urls).toEqual({ ...PROVIDER_BASE_URLS });
  });
});
