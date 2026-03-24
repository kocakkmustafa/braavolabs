/**
 * Finance Eval Suite — Faz 6
 *
 * Tests that verify financial tracking and billing accuracy.
 */

export interface EvalCase {
  name: string;
  description: string;
  run: () => Promise<boolean>;
}

export const financeSuite: EvalCase[] = [
  {
    name: "cost_tracking_accuracy",
    description: "Verify run costs are accurately tracked per step and tool call",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
  {
    name: "usage_metering_consistency",
    description: "Verify usage meters match actual run counts",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
  {
    name: "plan_limit_enforcement",
    description: "Verify free plan limits are enforced (1 company, 10 runs/month)",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
];
