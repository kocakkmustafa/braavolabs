# @ai-company-os/connector-sdk

Publisher-side SDK for authoring Braavolabs marketplace connectors (E5/T5).

A **connector** wraps a third-party MCP server so its tools can be installed by
any tenant and spliced into the agent loop. This package gives you:

- **`connectorManifestSchema`** — a Zod schema describing the connector
  manifest. The marketplace `POST /marketplace/publish` path validates every
  submission against it **fail-closed** (an invalid manifest is rejected 400,
  never persisted).
- **`createConnector(...)`** — a helper that validates your manifest at author
  time and produces a ready-to-POST publish body.
- **`canonicalManifestPayload(...)`** — the deterministic serialization of the
  signed portion of a manifest (tool surface + identity). The marketplace
  HMAC-signs this string at publish and re-verifies it at install/refresh, so a
  post-publish tool-set swap is detected.
- **Templates** — `templates/manifest.template.json` and
  `templates/connector.template.ts` scaffolds to copy.

## Quick start

```ts
import { createConnector } from "@ai-company-os/connector-sdk";

const connector = createConnector({
  slug: "acme-crm",
  name: "Acme CRM",
  vendor: "Acme Inc.",
  description: "Sync contacts and deals with Acme CRM.",
  mcpServerUrl: "https://mcp.acme.example/rpc",
  authMethod: "API_KEY",
  authFields: [{ name: "apiKey", type: "password", label: "API key" }],
  tools: [
    { name: "list_contacts", description: "List CRM contacts", riskHint: "low" },
    { name: "delete_contact", description: "Delete a contact", riskHint: "high" },
  ],
});

// POST connector.toPublishBody() to /marketplace/publish
```

## Manifest signature (HMAC)

The marketplace derives a **per-publisher-tenant** HMAC key from the platform
master key and signs the canonical manifest payload at publish time. On install
and refresh, the live MCP `tools/list` probe is re-canonicalized and verified
against the stored signature. A mismatch (a publisher swapping in a different
tool set after approval) is rejected. Publishers never handle the key — the
signature is computed and stored server-side.

## Risk hints

`riskHint` on a tool (`low` / `medium` / `high` / `money`) can only **raise**
the runtime's derived risk, never lower it. The agent runtime independently
derives risk from the tool name + description (`deriveConnectorToolMeta`), so an
under-declared tool still gets gated correctly.
