/**
 * Connector scaffold (E5/T5).
 *
 * Copy this file, edit the fields, and publish with:
 *
 *   POST /marketplace/publish   (body = connector.toPublishBody())
 *
 * `createConnector` validates the manifest FAIL-CLOSED at author time — a bad
 * manifest throws here, long before it reaches the marketplace.
 */
import { createConnector } from "@ai-company-os/connector-sdk";

const connector = createConnector({
  slug: "my-connector",
  name: "My Connector",
  version: "1.0.0",
  vendor: "My Company",
  description: "One-sentence description of what this connector does.",
  mcpServerUrl: "https://mcp.example.com/rpc",
  authMethod: "API_KEY",
  authFields: [
    { name: "apiKey", type: "password", required: true, label: "API key" },
  ],
  visibility: "PRIVATE",
  tools: [
    { name: "list_items", description: "List items (read-only).", riskHint: "low" },
    { name: "delete_item", description: "Delete an item by id.", riskHint: "high" },
  ],
});

export default connector;
