/**
 * D-005 — risk derivation for dynamic connector tools (E5/T4).
 *
 * A connector tool comes from a third-party MCP server: the runtime never
 * saw its handler and has no static ToolMeta for it. Left un-derived, the
 * old `dynamic-tools.ts` hard-coded `{ requiresApproval:false, riskLevel:"low" }`,
 * which — once the tool is spliced into the agent loop (T7) — would let a
 * remote DELETE / send-email / charge-card tool run un-gated at EVERY
 * autonomy level (registry.requiresApprovalForAutonomy short-circuits on a
 * low/no-approval meta).
 *
 * This module derives a conservative ToolMeta from what we DO know about a
 * remote tool: its name, description, JSON-Schema input, and an optional
 * publisher-declared risk hint. The verbs are matched against the tool's
 * NAME and DESCRIPTION (models sometimes name a tool `run` but describe it
 * as "delete the record"), never the raw input values.
 *
 * Design: FAIL SAFE. When a tool is ambiguous we default to
 * medium + requiresApproval (a human sees it once), never to "low".
 */

import type { ToolMeta } from "../agent/registry";

/**
 * Money verbs — a match flips `moneyTouching:true`, which
 * `isMoneyTouching` gates at EVERY autonomy level (CLAUDE.md rule #3,
 * inviolable). These are the highest-consequence side effects.
 */
const MONEY_VERBS = [
  "pay",
  "payment",
  "charge",
  "transfer",
  "wire",
  "purchase",
  "buy",
  "refund",
  "checkout",
  "invoice",
  "payout",
  "withdraw",
  "billing",
  // additional clearly-money terms (money-gating is inviolable per CLAUDE.md #3,
  // so err toward false positives over false negatives):
  "deposit",
  "remit",
  "disburse",
  "chargeback",
  "subscribe",
  "subscription",
  "bill",
  "sepa",
  "ach",
  "iban",
  "settle",
  "settlement",
];

/**
 * High-risk mutating / side-effecting verbs. A match sets
 * riskLevel:"high" + requiresApproval:true.
 */
const HIGH_RISK_VERBS = [
  "delete",
  "remove",
  "drop",
  "destroy",
  "purge",
  "send",
  "email",
  "post",
  "publish",
  "deploy",
  "create",
  "update",
  "write",
  "insert",
  "upsert",
  "execute",
  "run",
  "trigger",
  "cancel",
  "revoke",
  "grant",
  "approve",
  "merge",
  "push",
  "upload",
  "invite",
  "disable",
  "enable",
];

/**
 * Read-only verbs. A match (and NO higher-risk / money match) yields the
 * only "low" verdict — pure reads run freely so the agent loop doesn't
 * stall waiting for approval on every `list`.
 */
const READ_VERBS = [
  "get",
  "list",
  "read",
  "search",
  "fetch",
  "query",
  "find",
  "lookup",
  "describe",
  "show",
  "view",
  "count",
  "check",
  "status",
];

/** Publisher-declared coarse hint (future connector-SDK field). Never
 * LOWERS a derived risk — only raises it. */
export type PublisherRiskHint = "low" | "medium" | "high" | "money" | undefined;

/** Whole-word-ish match: the verb appears as a token in the haystack.
 * Splits on non-alphanumerics so `delete_record`, `deleteRecord`
 * (lower-cased) and `delete the row` all match "delete", while
 * `undeletable` (substring) does NOT falsely match. camelCase is split by
 * lower-casing first then tokenizing on case boundaries. A trailing-`s`
 * plural (`charges`, `deletes`) is also stemmed so verbs conjugated in a
 * description still match. */
function hasVerb(haystack: string, verbs: string[]): boolean {
  const normalized = haystack
    // split camelCase / PascalCase into words before lower-casing
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  const tokens = new Set<string>();
  for (const t of normalized.split(/[^a-z0-9]+/).filter(Boolean)) {
    tokens.add(t);
    // Cheap stemming for 3rd-person / plural conjugations.
    if (t.length > 3 && t.endsWith("s")) tokens.add(t.slice(0, -1));
  }
  return verbs.some((v) => tokens.has(v));
}

/**
 * Derive a conservative ToolMeta for a dynamic connector tool.
 *
 * Precedence (highest wins):
 *   1. money verb (name/desc) OR publisher hint "money"  → moneyTouching + high + approval
 *   2. high-risk verb (name/desc) OR publisher hint "high" → high + approval
 *   3. publisher hint "medium"                            → medium + approval
 *   4. read verb (name/desc) AND no higher signal         → low, no approval
 *   5. anything else (ambiguous)                          → medium + approval (fail-safe)
 */
export function deriveConnectorToolMeta(
  name: string,
  description?: string,
  _inputSchema?: Record<string, unknown>,
  publisherRiskHint?: PublisherRiskHint,
): ToolMeta {
  const haystack = `${name ?? ""} ${description ?? ""}`;

  const moneySignal = publisherRiskHint === "money" || hasVerb(haystack, MONEY_VERBS);
  if (moneySignal) {
    return { requiresApproval: true, riskLevel: "high", moneyTouching: true };
  }

  // Non-money branches set `moneyTouching:false` EXPLICITLY so the
  // isMoneyTouching fallback (moneyTouching ?? requiresApproval) does not
  // mis-classify an approval-required *action* tool as money — that would gate
  // it even under AUTONOMOUS. Here approval is driven by RISK LEVEL, not money.
  const highSignal = publisherRiskHint === "high" || hasVerb(haystack, HIGH_RISK_VERBS);
  if (highSignal) {
    return { requiresApproval: true, riskLevel: "high", moneyTouching: false };
  }

  if (publisherRiskHint === "medium") {
    return { requiresApproval: true, riskLevel: "medium", moneyTouching: false };
  }

  // A read verb only wins when nothing more dangerous matched above.
  const readSignal = hasVerb(haystack, READ_VERBS);
  if (readSignal && publisherRiskHint !== "low") {
    // publisher may still force low; but a read verb already IS low.
    return { requiresApproval: false, riskLevel: "low", moneyTouching: false };
  }
  if (publisherRiskHint === "low") {
    return { requiresApproval: false, riskLevel: "low", moneyTouching: false };
  }

  // Ambiguous: unknown verb, no read signal, no hint. Fail SAFE — a human
  // approves it once rather than letting an unknown remote side effect run.
  return { requiresApproval: true, riskLevel: "medium", moneyTouching: false };
}
