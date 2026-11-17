/**
 * Deterministic FAKE provider for dry-run and tests: no network, no keys,
 * no wall clock (a virtual clock advances per call).
 */
import { estimateTokens } from "./pricing";
import { REAL_RUN_TASKS } from "./set";
import type { ProviderCall } from "./runner";

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function makeFakeProvider(opts: { stuff?: boolean } = {}): { call: ProviderCall; now: () => number; calls: () => number } {
  let clock = 0;
  let n = 0;
  const call: ProviderCall = async (req) => {
    n++;
    const h = hash(`${req.provider}|${req.model}|${req.taskId}`);
    clock += 100 + (h % 900);
    const task = REAL_RUN_TASKS.find((t) => t.id === req.taskId);
    const good = (h >>> 5) % 4 !== 0; // ~75% "correct"
    let content = "I cannot tell.";
    if (task?.scorer.kind === "label") {
      content = good ? task.scorer.expected : "AUTO";
    } else if (task?.scorer.kind === "keywords") {
      if (opts.stuff) {
        // Keyword stuffing: every alternative of every group, no prose.
        content = task.scorer.groups.flat().map((a) => a.replace(/\*$/, "")).join(" ");
      } else {
        const picked = task.scorer.groups.filter((_, i) => good || i % 2 === 0).map((g) => g[0].replace(/\*$/, ""));
        content = `The answer is that ${picked.join(" and ")} apply to this case.`;
      }
    }
    return {
      content,
      inputTokens: estimateTokens(req.system) + estimateTokens(req.prompt),
      outputTokens: 40 + ((h >>> 9) % Math.max(1, req.maxTokens - 40)),
    };
  };
  return { call, now: () => clock, calls: () => n };
}
