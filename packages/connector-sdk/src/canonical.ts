/**
 * Canonical serialization of the signed portion of a connector manifest
 * (E5/T5). The HMAC signature is computed over this string, NOT over the raw
 * publish body — so key ordering, defaults, and whitespace can't change the
 * signed bytes between publish-time and verify-time.
 *
 * The signed payload is intentionally the *tool surface* (the security-
 * relevant part: what tools the agent loop may invoke), plus the identity
 * fields that scope it. Cosmetic fields (iconUrl, description) are excluded so
 * a publisher can fix a typo without re-signing — the runtime only cares that
 * the *tool set* wasn't swapped after approval.
 */

import type { McpToolLike } from "./types";

/** Stable JSON: object keys sorted recursively so serialization is
 * deterministic regardless of property insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Collapse the handful of representations that all mean "this tool takes no
 * input" — `undefined`/`null`, `{}`, and `{ type:"object", properties:{} }` —
 * to ONE canonical form (`{}`), so a no-argument tool signs and verifies
 * identically no matter whether the publish-time declaration or the live MCP
 * probe spells the empty schema as `{}` or `{ type:"object", properties:{} }`.
 * Without this, an argument-less connector whose declared and probed empty
 * schemas differ representationally would false-reject with a 409 on install/
 * refresh (fail-closed, but a legitimate connector becomes un-installable).
 *
 * Only genuinely-empty object schemas are collapsed: any schema carrying real
 * `properties`, `required`, or other constraint keys passes through untouched,
 * so a real input-shape swap still changes the signature (integrity preserved).
 */
function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || schema === undefined || typeof schema !== "object") return {};
  const obj = schema as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};
  // `{ type:"object", properties:{} }` (and nothing else meaningful) is the
  // MCP-spec way of saying "no args"; treat it as the empty schema.
  const props = obj.properties;
  const propsEmpty =
    props === undefined ||
    (typeof props === "object" && props !== null && Object.keys(props as object).length === 0);
  const onlyTypeAndProps = keys.every((k) => k === "type" || k === "properties");
  if (obj.type === "object" && propsEmpty && onlyTypeAndProps) return {};
  return obj;
}

/**
 * Build the canonical string that gets HMAC-signed. `slug` + `version` scope
 * the signature; the tool list (name + inputSchema, sorted by name) is the
 * integrity-protected surface. Descriptions are included because a swapped
 * description can change a tool's derived risk (deriveConnectorToolMeta reads
 * name AND description).
 */
export function canonicalManifestPayload(input: {
  slug: string;
  version: string;
  tools: McpToolLike[];
}): string {
  const tools = [...(input.tools ?? [])]
    .map((t) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema: normalizeInputSchema(t.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return stableStringify({ slug: input.slug, version: input.version, tools });
}
