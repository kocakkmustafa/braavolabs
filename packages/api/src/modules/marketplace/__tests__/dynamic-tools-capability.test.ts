/** BRA-P1-03d — cachedToolsManifest capability is carried to remote.declaredCapability. */
import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("../../../lib/db", () => ({ prisma: { tenantConnector: { findMany: (...a: unknown[]) => findMany(...a) } } }));
vi.mock("../../../lib/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("../../../lib/mcp", () => ({ callTool: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { listConnectorToolsForTenant } from "../dynamic-tools";

describe("listConnectorToolsForTenant declaredCapability", () => {
  it("carries capability; absent stays undefined", async () => {
    findMany.mockResolvedValue([
      {
        scopes: [],
        connector: { slug: "acme", name: "Acme" },
        cachedToolsManifest: [
          { name: "ship", description: "x", capability: "deploy" },
          { name: "list", description: "y" },
        ],
      },
    ]);
    const tools = await listConnectorToolsForTenant("t1");
    expect(tools.find((t) => t.remote?.name === "ship")?.remote?.declaredCapability).toBe("deploy");
    expect(tools.find((t) => t.remote?.name === "list")?.remote?.declaredCapability).toBeUndefined();
  });
});
