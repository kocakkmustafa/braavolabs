/** Shared types for automation-importer adapters. */

export interface ConvertedPipeline {
  pipeline: {
    name: string;
    description?: string;
    steps: Array<{ id: string; type: string; config: unknown }>;
  };
  dropped: Array<{ id: string; type: string; reason: string }>;
  warnings: string[];
}
