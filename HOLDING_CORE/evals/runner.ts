/**
 * Eval Suite Runner — Faz 6
 *
 * Runs all eval suites and stores results.
 * Can be triggered via API or CLI.
 */

import { safetySuite } from "./safety_suite";
import { salesQualitySuite } from "./sales_quality_suite";
import { contentQualitySuite } from "./content_quality_suite";
import { memorySuite } from "./memory_suite";
import { financeSuite } from "./finance_suite";

export interface EvalCase {
  name: string;
  description: string;
  run: () => Promise<boolean>;
}

export interface EvalResult {
  suite: string;
  name: string;
  description: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface EvalSuiteResult {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
  durationMs: number;
}

const ALL_SUITES: Record<string, EvalCase[]> = {
  safety: safetySuite,
  sales_quality: salesQualitySuite,
  content_quality: contentQualitySuite,
  memory: memorySuite,
  finance: financeSuite,
};

/**
 * Run a single eval suite.
 */
export async function runSuite(suiteName: string): Promise<EvalSuiteResult> {
  const cases = ALL_SUITES[suiteName];
  if (!cases) throw new Error(`Unknown eval suite: ${suiteName}`);

  const results: EvalResult[] = [];
  const start = Date.now();

  for (const evalCase of cases) {
    const caseStart = Date.now();
    let passed = false;
    let error: string | undefined;

    try {
      passed = await evalCase.run();
    } catch (err) {
      passed = false;
      error = err instanceof Error ? err.message : String(err);
    }

    results.push({
      suite: suiteName,
      name: evalCase.name,
      description: evalCase.description,
      passed,
      error,
      durationMs: Date.now() - caseStart,
    });
  }

  return {
    suite: suiteName,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
    durationMs: Date.now() - start,
  };
}

/**
 * Run all eval suites.
 */
export async function runAllSuites(): Promise<EvalSuiteResult[]> {
  const results: EvalSuiteResult[] = [];

  for (const suiteName of Object.keys(ALL_SUITES)) {
    results.push(await runSuite(suiteName));
  }

  return results;
}

/**
 * Get available suite names.
 */
export function getAvailableSuites(): string[] {
  return Object.keys(ALL_SUITES);
}
