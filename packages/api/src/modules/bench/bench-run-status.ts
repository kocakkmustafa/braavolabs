/** BenchRun.status values + constant errorCodes (BRA-P1-05-N2). Kept in its
 * own module so the public router can import it without pulling the service
 * (the mount-smoke test mocks bench.service). */
export const BENCH_RUN_STATUS = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;

export type BenchRunStatus = (typeof BENCH_RUN_STATUS)[keyof typeof BENCH_RUN_STATUS];

export const BENCH_ERROR_CODE = {
  NO_CANDIDATE_KEY: "NO_CANDIDATE_KEY",
  NO_JUDGE_KEY: "NO_JUDGE_KEY",
  RUN_ERROR: "RUN_ERROR",
} as const;

export type BenchErrorCode = (typeof BENCH_ERROR_CODE)[keyof typeof BENCH_ERROR_CODE];
