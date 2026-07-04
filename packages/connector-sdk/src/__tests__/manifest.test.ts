/**
 * E5/T5 — connector manifest schema + createConnector + canonicalization.
 */
import { describe, it, expect } from "vitest";
import {
  connectorManifestSchema,
  validateManifest,
} from "../manifest.schema";
import { createConnector } from "../createConnector";
import { canonicalManifestPayload } from "../canonical";

const valid = {
  slug: "acme-crm",
  name: "Acme CRM",
  vendor: "Acme Inc.",
  description: "Sync contacts with Acme CRM.",
  mcpServerUrl: "https://mcp.acme.example/rpc",
  authMethod: "API_KEY" as const,
  tools: [
    { name: "list_contacts", description: "List contacts" },
    { name: "delete_contact", description: "Delete a contact" },
  ],
};

describe("connectorManifestSchema — fail-closed validation", () => {
  it("accepts a valid manifest and applies defaults", () => {
    const parsed = connectorManifestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe("1.0.0");
      expect(parsed.data.visibility).toBe("PRIVATE");
      expect(parsed.data.manifestVersion).toBe(1);
    }
  });

  it("rejects an invalid slug (uppercase/underscore)", () => {
    const r = validateManifest({ ...valid, slug: "Acme_CRM" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("slug"))).toBe(true);
  });

  it("rejects a non-semver version", () => {
    const r = validateManifest({ ...valid, version: "1.0" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-URL mcpServerUrl", () => {
    const r = validateManifest({ ...valid, mcpServerUrl: "not-a-url" });
    expect(r.ok).toBe(false);
  });

  it("rejects a tool name with illegal characters", () => {
    const r = validateManifest({
      ...valid,
      tools: [{ name: "delete contact!", description: "x" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing required field (vendor)", () => {
    const { vendor, ...withoutVendor } = valid;
    void vendor;
    const r = validateManifest(withoutVendor);
    expect(r.ok).toBe(false);
  });
});

describe("createConnector", () => {
  it("throws on an invalid manifest (author-time fail-closed)", () => {
    expect(() => createConnector({ ...valid, slug: "X" } as never)).toThrow(
      /Invalid connector manifest/,
    );
  });

  it("returns a publish body and a stable canonical payload", () => {
    const c = createConnector(valid);
    const body = c.toPublishBody();
    expect(body.slug).toBe("acme-crm");
    expect(body.authSchema).toEqual({ fields: [] });
    expect(typeof c.canonicalPayload).toBe("string");
    // Canonical payload is order-independent for tools.
    const reordered = createConnector({
      ...valid,
      tools: [valid.tools[1]!, valid.tools[0]!],
    });
    expect(reordered.canonicalPayload).toBe(c.canonicalPayload);
  });
});

describe("canonicalManifestPayload", () => {
  it("is deterministic regardless of tool order and object key order", () => {
    const a = canonicalManifestPayload({
      slug: "s",
      version: "1.0.0",
      tools: [
        { name: "b", description: "B", inputSchema: { type: "object", x: 1 } },
        { name: "a", description: "A", inputSchema: { x: 1, type: "object" } },
      ],
    });
    const b = canonicalManifestPayload({
      slug: "s",
      version: "1.0.0",
      tools: [
        { name: "a", description: "A", inputSchema: { type: "object", x: 1 } },
        { name: "b", description: "B", inputSchema: { type: "object", x: 1 } },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when a tool is added or renamed (swap detection)", () => {
    const base = canonicalManifestPayload({
      slug: "s",
      version: "1.0.0",
      tools: [{ name: "list", description: "read" }],
    });
    const swapped = canonicalManifestPayload({
      slug: "s",
      version: "1.0.0",
      tools: [{ name: "delete_all", description: "danger" }],
    });
    expect(base).not.toBe(swapped);
  });
});
