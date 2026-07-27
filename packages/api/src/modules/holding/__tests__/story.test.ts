import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestMock = vi.hoisted(() => vi.fn(async () => ({ id: "ev_1", deduped: false })));
vi.mock("../sentinel", () => ({ ingestSentinelEvent: ingestMock }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../audit", () => ({ audit: auditMock }));

import { captureStoryCandidate, StoryCaptureRefused } from "../story";

beforeEach(() => {
  ingestMock.mockClear();
  ingestMock.mockResolvedValue({ id: "ev_1", deduped: false });
  auditMock.mockClear();
});

describe("captureStoryCandidate", () => {
  it("captures a merge as an INFO story_candidate with ref-based dedup", async () => {
    await captureStoryCandidate({
      kind: "merge",
      venture: "braavolabs",
      title: "Holding motor çekirdeği dala girdi",
      ref: "2ba2900",
    });
    const arg = ingestMock.mock.calls[0][0];
    expect(arg.kind).toBe("story_candidate");
    expect(arg.severity).toBe("INFO");
    expect(arg.salient).toBe("braavolabs|merge|2ba2900");
    expect(auditMock).toHaveBeenCalledOnce();
  });

  it("a deduped capture does not re-audit", async () => {
    ingestMock.mockResolvedValue({ id: "ev_1", deduped: true });
    await captureStoryCandidate({ kind: "release", venture: "lifeos", title: "b18", ref: "v1.0-b18" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("REFUSES Iron Bank content at the door (kalıcı kurucu kararı)", async () => {
    await expect(
      captureStoryCandidate({ kind: "milestone", venture: "iron-bank", title: "döngü 9", ref: "x" }),
    ).rejects.toBeInstanceOf(StoryCaptureRefused);
    await expect(
      captureStoryCandidate({ kind: "milestone", venture: "holding", title: "Iron Bank tarayıcısı", ref: "y" }),
    ).rejects.toBeInstanceOf(StoryCaptureRefused);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("requires venture, title and ref", async () => {
    await expect(
      captureStoryCandidate({ kind: "merge", venture: " ", title: "t", ref: "r" }),
    ).rejects.toBeInstanceOf(StoryCaptureRefused);
  });
});
