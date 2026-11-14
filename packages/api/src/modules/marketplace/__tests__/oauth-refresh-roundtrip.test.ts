/** BRA-P1-02a — real encrypt/decrypt round trip of the refreshed credential under the connector AAD. */
import { describe, expect, it, vi } from "vitest";
import { encrypt, decrypt } from "../../../lib/encryption";
import { connectorAad } from "../connector-lifecycle";

const store: { value: string } = { value: "" };
const updateMany = vi.fn(async (a: { where: { encryptedCredentials: string }; data: { encryptedCredentials: string } }) => {
  if (a.where.encryptedCredentials !== store.value) return { count: 0 };
  store.value = a.data.encryptedCredentials;
  return { count: 1 };
});
vi.mock("../../../lib/db", () => ({
  prisma: { tenantConnector: { findFirst: async () => ({ encryptedCredentials: store.value }), updateMany: (a: never) => updateMany(a) } },
}));
vi.mock("../../../lib/ssrf", () => ({
  safeExternalFetch: async () => new Response(JSON.stringify({ access_token: "REAL-NEW-ACCESS", refresh_token: "REAL-NEW-REFRESH", expires_in: 3600 }), { status: 200 }),
}));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureFreshCredentials } from "../oauth-refresh";

describe("oauth refresh — real crypto", () => {
  it("persists a decryptable credential under the connector AAD", async () => {
    const aad = connectorAad("t1", "c1");
    const creds = { accessToken: "old", refreshToken: "r0", expiresAt: "1", tokenUrl: "https://auth.example/token" };
    store.value = encrypt(JSON.stringify(creds), aad);
    const out = await ensureFreshCredentials("t1", { id: "i1", connector: { id: "c1", authMethod: "OAUTH2", mcpServerUrl: "https://m.example/rpc" } }, creds);
    expect(out.accessToken).toBe("REAL-NEW-ACCESS");
    const saved = JSON.parse(decrypt(store.value, aad));
    expect(saved).toMatchObject({ accessToken: "REAL-NEW-ACCESS", refreshToken: "REAL-NEW-REFRESH" });
    expect(() => decrypt(store.value, connectorAad("t2", "c1"))).toThrow();
  });
});
