import { describe, expect, it } from "vitest";
import { parseKaput } from "./facts";

describe("Kaputu Aç — T7 (savunmacı okuma)", () => {
  it("bozuk gövde boş Kaput verir, fırlatmaz", () => {
    for (const bad of [null, undefined, 3, "x", [], { steps: "no" }]) expect(parseKaput(bad)).toMatchObject({ steps: [], toolCallCount: 0, handoffCount: null });
  });
  it("adım + araç çağrısı + maliyet okunur; eksik alanlar null", () => {
    const k = parseKaput({ costUsd: "0.42", steps: [
      { id: "s1", stepIndex: 0, name: "Oku", status: "COMPLETED", costUsd: 0.05, durationMs: 10, toolCalls: [{ id: "t", toolName: "gmail.list", status: "completed", durationMs: 5 }, 7] },
      { agentRole: "yazar", status: null },
    ] });
    expect(k.totalCostUsd).toBe(0.42);
    expect(k.steps).toHaveLength(2);
    expect(k.steps[0]).toMatchObject({ name: "Oku", status: "completed", costUsd: 0.05 });
    expect(k.steps[0].toolCalls).toEqual([{ id: "t", toolName: "gmail.list", status: "completed", durationMs: 5, error: null }]);
    expect(k.steps[1]).toMatchObject({ name: "yazar", status: "unknown", costUsd: null, toolCalls: [] });
    expect(k.toolCallCount).toBe(1);
  });
});
