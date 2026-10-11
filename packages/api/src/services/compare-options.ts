import { listTenantProviderLinks } from "./provider-chain";
import { supportedReasoningEfforts, type ReasoningEffort } from "./reasoning-effort";

export interface CompareSelectionOption {
  provider: string;
  model: string;
  reasoningEfforts: readonly ReasoningEffort[];
}

/** Stored tenant links only: no catalogue, key resolution, inference or live probe.
 * Ambiguous pairs cannot be selected and are deliberately omitted. This metadata
 * is advisory; the selected compare endpoint revalidates before creating a session. */
export async function listCompareSelectionOptions(tenantId: string): Promise<CompareSelectionOption[]> {
  const links = await listTenantProviderLinks(tenantId);
  const key = (provider: string, model: string) => JSON.stringify([provider, model]);
  const counts = new Map<string, number>();
  for (const link of links) {
    const id = key(link.provider, link.config.model);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return links.filter(link => counts.get(key(link.provider, link.config.model)) === 1)
    .map(link => ({provider: link.provider, model: link.config.model,
      reasoningEfforts: supportedReasoningEfforts(link.config)}));
}
