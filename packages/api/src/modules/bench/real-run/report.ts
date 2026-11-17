import type { RealRunReport } from "./runner";

const usd = (micro: number): string => (micro / 1_000_000).toFixed(6);

/** Markdown summary. Only task ids, numbers and constant codes: no prompts, no keys. */
export function reportToMarkdown(r: RealRunReport): string {
  const lines: string[] = [
    `# Bench real-run (${r.mode})`,
    "",
    `- setVersion: ${r.setVersion}`,
    `- setHash: ${r.setHash}`,
    `- tasks: ${r.taskCount}`,
    `- status: ${r.status}`,
    `- cap: ${usd(r.capMicroUsd)} USD`,
    `- estimate (worst case): ${usd(r.estimate.totalMicroUsd)} USD`,
    `- spent: ${usd(r.spentMicroUsd)} USD`,
    "",
  ];
  for (const t of r.targets) {
    lines.push(
      `## ${t.provider} / ${t.model}`,
      "",
      `mean score: ${t.meanScore ?? "n/a"} | cost: ${usd(t.totalCostMicroUsd)} USD | mean latency: ${t.meanLatencyMs ?? "n/a"} ms`,
      "",
      "| task | status | score | cost (USD) | latency ms |",
      "|---|---|---|---|---|",
    );
    for (const k of t.tasks) {
      lines.push(`| ${k.taskId} | ${k.status}${k.errorCode ? ` (${k.errorCode})` : ""} | ${k.score ?? "-"} | ${usd(k.costMicroUsd)}${k.costEstimated ? "*" : ""} | ${k.latencyMs ?? "-"} |`);
    }
    lines.push("");
  }
  lines.push("`*` = worst-case charge for a failed attempt (real usage unknown).", "");
  return lines.join("\n");
}
