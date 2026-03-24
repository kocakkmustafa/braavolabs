/**
 * Memory Eval Suite — Faz 6
 *
 * Tests that verify memory engine correctness.
 */

export interface EvalCase {
  name: string;
  description: string;
  run: () => Promise<boolean>;
}

export const memorySuite: EvalCase[] = [
  {
    name: "no_single_example_generalization",
    description: "Verify memories are not promoted from a single example",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
  {
    name: "lifecycle_compliance",
    description: "Verify memory status follows candidate → approved → deprecated lifecycle",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
  {
    name: "holding_brain_promotion_requires_2_companies",
    description: "Verify holding brain promotion requires success in 2+ companies",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
  {
    name: "similarity_search_accuracy",
    description: "Verify semantic search returns relevant results",
    run: async () => {
      // TODO: Faz 6
      return true;
    },
  },
];
