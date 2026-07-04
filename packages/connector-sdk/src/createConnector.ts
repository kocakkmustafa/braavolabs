/**
 * `createConnector` — the publisher-facing helper (E5/T5).
 *
 * A connector author writes a small TypeScript file that calls this helper to
 * declare their connector. It validates the manifest FAIL-CLOSED at author time
 * (throws on an invalid manifest) so a broken connector never reaches the
 * `POST /marketplace/publish` step, and returns the normalized manifest plus a
 * ready-to-POST publish body.
 *
 * Example:
 *
 *   import { createConnector } from "@ai-company-os/connector-sdk";
 *
 *   export default createConnector({
 *     slug: "acme-crm",
 *     name: "Acme CRM",
 *     vendor: "Acme Inc.",
 *     description: "Sync contacts and deals with Acme CRM.",
 *     mcpServerUrl: "https://mcp.acme.example/rpc",
 *     authMethod: "API_KEY",
 *     authFields: [{ name: "apiKey", type: "password", label: "API key" }],
 *     tools: [
 *       { name: "list_contacts", description: "List CRM contacts", riskHint: "low" },
 *       { name: "delete_contact", description: "Delete a contact", riskHint: "high" },
 *     ],
 *   });
 */

import {
  connectorManifestSchema,
  validateManifest,
  type ConnectorManifest,
  type ConnectorManifestInput,
} from "./manifest.schema";
import { canonicalManifestPayload } from "./canonical";

export interface CreatedConnector {
  manifest: ConnectorManifest;
  /** The exact string the marketplace HMAC-signs. Publishers can log/inspect
   * it; the server recomputes it independently. */
  canonicalPayload: string;
  /** A body ready to `POST /marketplace/publish`. */
  toPublishBody(): Record<string, unknown>;
}

export function createConnector(input: ConnectorManifestInput): CreatedConnector {
  const result = validateManifest(input);
  if (!result.ok) {
    throw new Error(
      `Invalid connector manifest:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  const manifest = result.manifest;
  const canonicalPayload = canonicalManifestPayload({
    slug: manifest.slug,
    version: manifest.version,
    tools: manifest.tools,
  });
  return {
    manifest,
    canonicalPayload,
    toPublishBody() {
      return {
        slug: manifest.slug,
        name: manifest.name,
        version: manifest.version,
        vendor: manifest.vendor,
        description: manifest.description,
        iconUrl: manifest.iconUrl,
        documentationUrl: manifest.documentationUrl,
        mcpServerUrl: manifest.mcpServerUrl,
        authMethod: manifest.authMethod,
        // The publish body's authSchema is `{ fields: [...] }`.
        authSchema: { fields: manifest.authFields },
        visibility: manifest.visibility,
        tools: manifest.tools,
      };
    },
  };
}

export { connectorManifestSchema };
