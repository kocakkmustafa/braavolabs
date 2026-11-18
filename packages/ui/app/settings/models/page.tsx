import { notFound } from "next/navigation";
import ModelsOverviewPage from "../../../components/models/ModelsOverviewPage";
import { uxModelsEnabled } from "../../../lib/ux-models/flag";

/**
 * BRA-UX-05h — Modeller ve bağlantılar (E11). Bayrak (`NEXT_PUBLIC_UX_MODELS`) KAPALIYKEN rota yok sayılır (404); açıkken
 * `GET /companies/:id/models` dökümünü gösterir. Bayrak istek anında okunur (`force-dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default function ModelsPage() {
  if (!uxModelsEnabled()) notFound();
  return <ModelsOverviewPage />;
}
