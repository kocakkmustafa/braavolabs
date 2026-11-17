/**
 * Compose taslağı doğrulama (BRA-UX-API-03).
 *
 * "Taslak → Oluştur" adımında taslak istemcide tutulur ve oluşturmada yeniden
 * gönderilir; istemci verisi güvenilmezdir. Bu yüzden oluşturma, composer'ın
 * kullandığı aynı zod şemasını ve aynı araç beyaz listesini yeniden uygular.
 */
import { ComposedAgentSchema, type ComposedAgent } from "./composer";
import { getToolNames } from "./registry";

export function sanitizeComposedDraft(raw: unknown): { agent: ComposedAgent; droppedTools: string[] } {
  const parsed = ComposedAgentSchema.parse(raw);
  const registered = new Set(getToolNames());
  const tools: string[] = [];
  const droppedTools: string[] = [];
  for (const t of parsed.tools) (registered.has(t) ? tools : droppedTools).push(t);
  return { agent: { ...parsed, tools }, droppedTools };
}
