import { ingestSentinelEvent } from "./sentinel";
import { audit } from "./audit";

/**
 * GP1 story-capture (FABLE_PLAN Paket 5 + Böl.22): every real build event
 * (merge, release, incident close, milestone) automatically becomes a
 * `story_candidate` — the raw feed the build-in-public content pipeline
 * drafts from. Capture is UNCONDITIONAL and cheap; editorial selection and
 * the Muhafız gates (disclosure, AI-label, factuality) happen downstream
 * before anything is published. Iron Bank sources are refused at the door
 * (kalıcı kurucu kararı — Anayasa §4).
 */

export type StoryEventKind = "merge" | "release" | "incident-close" | "milestone";

export interface StoryEvent {
  kind: StoryEventKind;
  venture: string;
  title: string;
  /** Commit hash / PR url / finding id — the factual anchor of the story. */
  ref: string;
  detail?: string;
}

export class StoryCaptureRefused extends Error {}

export async function captureStoryCandidate(event: StoryEvent): Promise<{ id: string; deduped: boolean }> {
  if (/iron[-\s]?bank/i.test(`${event.venture} ${event.title} ${event.detail ?? ""}`)) {
    throw new StoryCaptureRefused("Iron Bank is permanently out of build-in-public scope");
  }
  if (!event.venture?.trim() || !event.title?.trim() || !event.ref?.trim()) {
    throw new StoryCaptureRefused("venture, title and ref are required");
  }

  const result = await ingestSentinelEvent({
    source: "story-capture",
    kind: "story_candidate",
    severity: "INFO",
    trustLevel: "TRUSTED",
    payload: {
      storyKind: event.kind,
      venture: event.venture,
      title: event.title,
      ref: event.ref,
      detail: event.detail?.slice(0, 1000),
    },
    // Dedup per factual anchor: the same merge never spawns two candidates.
    salient: `${event.venture}|${event.kind}|${event.ref}`,
  });

  if (!result.deduped) {
    await audit({
      actor: "holding.story-capture",
      action: "holding.story_candidate_captured",
      entity: "holding_sentinel_event",
      entityId: result.id,
      payload: { venture: event.venture, kind: event.kind, ref: event.ref },
    });
  }
  return result;
}
