/**
 * E5 payload masking (Açık Soru #2) — secret-like keys are redacted before the
 * verbatim payload is persisted; non-secret data and structure are preserved.
 */
import { describe, it, expect } from "vitest";
import { maskSecrets, MASK } from "../mask-secrets";

describe("maskSecrets", () => {
  it("redacts common credential keys at any depth", () => {
    const input = {
      name: "flow",
      credentials: {
        apiKey: "sk-live-123",
        headers: { Authorization: "Bearer abc", "X-Api-Token": "t" },
      },
      nodes: [{ password: "hunter2", label: "ok" }],
    };
    const out = maskSecrets(input) as any;
    expect(out.name).toBe("flow");
    expect(out.credentials).toBe(MASK); // key "credentials" itself is secret-like
    expect(out.nodes[0].password).toBe(MASK);
    expect(out.nodes[0].label).toBe("ok");
  });

  it("redacts nested token/secret/authorization keys but keeps siblings", () => {
    const input = {
      config: { token: "abc", url: "https://api.example.com", client_secret: "z" },
    };
    const out = maskSecrets(input) as any;
    expect(out.config.token).toBe(MASK);
    expect(out.config.client_secret).toBe(MASK);
    expect(out.config.url).toBe("https://api.example.com");
  });

  it("is case-insensitive on key names", () => {
    const out = maskSecrets({ APIKEY: "x", Password: "y", SECRET: "z" }) as any;
    expect(out.APIKEY).toBe(MASK);
    expect(out.Password).toBe(MASK);
    expect(out.SECRET).toBe(MASK);
  });

  it("returns non-object payloads (markdown strings) unchanged", () => {
    expect(maskSecrets("## Routine\napiKey is just text here")).toBe(
      "## Routine\napiKey is just text here",
    );
  });

  it("leaves a clean payload structurally identical", () => {
    const clean = { name: "x", steps: [{ id: "1", type: "http" }] };
    expect(maskSecrets(clean)).toEqual(clean);
  });
});
