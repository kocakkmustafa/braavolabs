import JobWorkspace from "../../../components/job/JobWorkspace";
import RunDetailLegacy from "../../../components/runs/RunDetailLegacy";
import { showWorkspace, uxWorkspaceEnabled } from "../../../lib/ux-workspace/flag";

/**
 * BRA-UX-05b — iş sayfası. Bayrak (`NEXT_PUBLIC_UX_WORKSPACE`) KAPALIYKEN eski ayrıntı sayfası (`RunDetailLegacy`) birebir sunulur;
 * açıkken birleşik çalışma alanı (kip morfu Özet/Çıktı/Kaput, ADR-0004). `?view=classic` bayrak açıkken de eski sayfayı verir
 * (yeniden çalıştırma, geri alma, ısı haritası orada). Bayrak istek anında okunur (`force-dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default async function RunPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams;
  return showWorkspace(uxWorkspaceEnabled(), view) ? <JobWorkspace /> : <RunDetailLegacy />;
}
