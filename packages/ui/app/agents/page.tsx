import { notFound } from "next/navigation";
import AgentsPage from "../../components/agents/AgentsPage";
import { uxAgentsEnabled } from "../../lib/ux-agents/flag";

/**
 * BRA-UX-05g — Ajanlar (E9). Bayrak (`NEXT_PUBLIC_UX_AGENTS`) KAPALIYKEN rota yok sayılır (404, BU BİLETTEN ÖNCEKİ davranış);
 * açıkken ajan listesi + "Taslak → Oluştur". Bayrak istek anında okunur (`force-dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default function AgentsRoute() {
  if (!uxAgentsEnabled()) notFound();
  return <AgentsPage />;
}
