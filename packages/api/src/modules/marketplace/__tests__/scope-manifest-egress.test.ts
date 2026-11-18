/**
 * SEC-BRA-03b — out-of-scope connector tools are hidden from the agent
 * manifest, and /installed rows never carry encryptedCredentials.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("../../../lib/db", () => ({ prisma: { tenantConnector: { findMany: (...a: unknown[]) => findMany(...a) } } }));
vi.mock("../../../lib/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("../../../lib/mcp", () => ({ callTool: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { listConnectorToolsForTenant } from "../dynamic-tools";
import { isToolInScope, toInstalledView } from "../connector-lifecycle";

const tools = [{ name: "read_doc" }, { name: "delete_doc" }];
const mk = (scopes: string[] | undefined) => ({
  id: "i1", scopes, cachedToolsManifest: tools,
  connector: { id: "c1", slug: "acme", name: "Acme" },
});

beforeEach(() => findMany.mockReset());

describe("listConnectorToolsForTenant — scope filter", () => {
  it("shows only granted tools", async () => {
    findMany.mockResolvedValue([mk(["read_doc"])]);
    const out = await listConnectorToolsForTenant("t1");
    expect(out.map((t) => t.name)).toEqual(["mcp_acme_read_doc"]);
  });
  it("empty scopes and '*' stay unrestricted (legacy)", async () => {
    findMany.mockResolvedValue([mk([]), mk(["*"]), mk(undefined)]);
    const out = await listConnectorToolsForTenant("t1");
    expect(out).toHaveLength(6);
  });
});

describe("isToolInScope", () => {
  it("exact match only", () => {
    expect(isToolInScope(["read_doc"], "read_doc")).toBe(true);
    expect(isToolInScope(["read_doc"], "read_doc2")).toBe(false);
    expect(isToolInScope(null, "x")).toBe(true);
  });
});

describe("toInstalledView", () => {
  it("drops encryptedCredentials, keeps the rest", () => {
    const row = { id: "i1", encryptedCredentials: "secret-blob", scopes: ["a"], connector: { slug: "acme" } };
    const v = toInstalledView(row);
    expect(v).not.toHaveProperty("encryptedCredentials");
    expect(JSON.stringify(v)).not.toContain("secret-blob");
    expect(v).toMatchObject({ id: "i1", scopes: ["a"] });
  });
});
