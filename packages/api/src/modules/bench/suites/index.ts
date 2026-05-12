/**
 * Built-in benchmark suites.
 *
 * Static task lists graded by an LLM-as-judge rubric. Each task has:
 *   - prompt: what the agent receives
 *   - rubric: scoring criteria the judge evaluates against
 *   - maxScore: per-task ceiling (defaults to suite.maxScorePerTask)
 *
 * Adding a new suite: drop another file in this directory exporting
 * a Suite object, then include it in BUILTIN_SUITES below. The
 * seedBenchSuites() helper writes every entry into the bench_suites
 * table on first boot.
 */

import { agentReasoningSuite } from "./agent-reasoning";
import { spendApprovalSuite } from "./spend-approval";
import { auditTraceSuite } from "./audit-trace";

export interface BenchTask {
  id: string;
  prompt: string;
  rubric: string;
  maxScore?: number;
}

export interface BenchSuiteDef {
  slug: string;
  name: string;
  description: string;
  maxScorePerTask: number;
  isPublic: boolean;
  tasks: BenchTask[];
}

export const BUILTIN_SUITES: BenchSuiteDef[] = [
  agentReasoningSuite,
  spendApprovalSuite,
  auditTraceSuite,
];
