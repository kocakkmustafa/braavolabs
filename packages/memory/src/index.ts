export { storeEpisodicMemory, recallEpisodicMemory } from "./episodic";
export { storeSemanticMemory, recallSemanticMemory } from "./semantic";
export { storeProceduralMemory, recallProceduralMemory } from "./procedural";
export { runConsolidation, type ConsolidationResult } from "./consolidation";
export { addEdge, removeEdge, getRelatedMemories, findContradictions, getSubgraph } from "./graph";
export { generateEmbedding, storeEmbedding, embedMemoryItem } from "./embedding";
export { searchMemory, searchMemoryText } from "./search";

// Obsidian-native project-memory vault writer (Forge P1a — least-token memory moat).
// Pure Markdown renderers + an injectable-FS MarkdownVault; logic verified by
// standalone tests (braavolabs-v2-workspace/vibecoding-slices/vault.test.ts, 11/11).
export {
  wikilink,
  frontmatter,
  renderHub,
  renderStatusNote,
  renderDecisionEntry,
  appendToDatedLog,
  renderSkill,
  renderHabits,
  MarkdownVault,
  type FsAdapter,
  type HubArea,
  type HabitsProfile,
} from "./vault";
