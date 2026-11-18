import StartIntent from "../../components/start/StartIntent";
import StartLegacy from "../../components/start/StartLegacy";
import { uxIntentEnabled } from "../../lib/ux-intent/flag";

/**
 * BRA-UX-05a — Başlangıç. Bayrak (`NEXT_PUBLIC_UX_INTENT`) KAPALIYKEN eski ekran (`StartLegacy`) birebir sunulur;
 * açıkken Niyet Çubuğu (ADR-0004). Bayrak istek anında okunur (`dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default function StartPage() {
  return uxIntentEnabled() ? <StartIntent /> : <StartLegacy />;
}
