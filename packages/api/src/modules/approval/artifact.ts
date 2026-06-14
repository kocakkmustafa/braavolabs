/**
 * Draft-artifact extraction for the approval queue (Feature D5).
 *
 * When an approval concerns generated CONTENT — a draft email, social post,
 * outreach message — the reviewer should see the ACTUAL work product (subject +
 * body, the post text), not just a one-line "Approval required for tool: X".
 * Lindy's signature move: review the draft, then approve/reject.
 *
 * The content can live in two places:
 *   1. The pending tool call's `metadata.input` (the agent is asking to act on
 *      a message it just composed — e.g. a voice-call `prompt`, an email body).
 *   2. The `drafts` table — a content tool (create_draft / generate_post /
 *      generate_outreach_pitch) persisted a row during the same run.
 *
 * This module returns a normalised `{ kind, title?, body }` artifact when one
 * is present and `null` otherwise (spend-only approvals stay exactly as-is).
 * It NEVER fabricates content — if there's nothing reviewable, it returns null.
 */

export interface ApprovalArtifact {
  /** Coarse content shape, drives the icon/label on the card. */
  kind: "email" | "social_post" | "message" | "content";
  /** Subject line / draft title, shown bold above the body. Optional. */
  title?: string;
  /** The reviewable body — email body, post text, outreach copy. */
  body: string;
  /** Where the content came from — "draft" (drafts row) or "action" (tool input). */
  source: "draft" | "action";
}

/** Bound the body so a runaway generation can't bloat the approvals payload. */
const MAX_BODY = 8_000;
const MAX_TITLE = 300;

function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

/** Map a free-form draft/channel hint to one of our coarse artifact kinds. */
function inferKind(hint: string | undefined): ApprovalArtifact["kind"] {
  const h = (hint ?? "").toLowerCase();
  if (/email|mail/.test(h)) return "email";
  if (/post|tiktok|linkedin|twitter|instagram|social|blog|ad_copy|ad-copy|video/.test(h)) return "social_post";
  if (/message|outreach|dm|sms|pitch|reply/.test(h)) return "message";
  return "content";
}

/**
 * Pull a reviewable artifact out of a pending tool call's input. Looks for the
 * well-known content fields agents populate (subject/body/content/message/post/
 * text/prompt). Returns null if the input carries no human-reviewable content
 * (e.g. ad_spend, which is pure budget — that stays a spend approval).
 */
export function extractArtifactFromInput(input: unknown): ApprovalArtifact | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  const title = clampStr(obj.subject, MAX_TITLE) ?? clampStr(obj.title, MAX_TITLE);

  // Body candidates, in priority order. The first non-empty wins.
  const body =
    clampStr(obj.body, MAX_BODY) ??
    clampStr(obj.content, MAX_BODY) ??
    clampStr(obj.message, MAX_BODY) ??
    clampStr(obj.post, MAX_BODY) ??
    clampStr(obj.text, MAX_BODY) ??
    clampStr(obj.prompt, MAX_BODY) ??
    clampStr(obj.draftBody, MAX_BODY);

  if (!body) return null;

  // Kind hint from explicit type/channel/platform fields, else the title/body.
  const hint =
    clampStr(obj.type, 50) ??
    clampStr(obj.channel, 50) ??
    clampStr(obj.platform, 50) ??
    title;

  return { kind: inferKind(hint), title, body, source: "action" };
}

/**
 * Normalise a `drafts` row's `content` JSON into an artifact. The content shape
 * is flexible (create_draft writes `{ body, hashtags }`, pitches write
 * `{ pitchType, body }`), so we coalesce the usual fields and append hashtags
 * when present so the reviewer sees the full post.
 */
export function artifactFromDraft(draft: {
  type?: string | null;
  title?: string | null;
  channel?: string | null;
  content: unknown;
}): ApprovalArtifact | null {
  const content =
    draft.content && typeof draft.content === "object" && !Array.isArray(draft.content)
      ? (draft.content as Record<string, unknown>)
      : {};

  let body =
    clampStr(content.body, MAX_BODY) ??
    clampStr(content.text, MAX_BODY) ??
    clampStr(content.message, MAX_BODY) ??
    // Fall back to a string-valued content field, or the whole JSON if it's a string.
    (typeof draft.content === "string" ? clampStr(draft.content, MAX_BODY) : undefined);

  // Append hashtags (social posts store them separately) so the review is whole.
  const tags = Array.isArray(content.hashtags)
    ? (content.hashtags as unknown[]).filter((x) => typeof x === "string")
    : [];
  if (body && tags.length > 0) {
    body = `${body}\n\n${tags.map((t) => (String(t).startsWith("#") ? t : `#${t}`)).join(" ")}`;
  }

  if (!body) return null;

  return {
    kind: inferKind(draft.type ?? draft.channel ?? draft.title ?? undefined),
    title: clampStr(draft.title, MAX_TITLE),
    body,
    source: "draft",
  };
}
