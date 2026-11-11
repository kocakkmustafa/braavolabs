import { notFound } from "next/navigation";
import UxLab from "../../../components/ux-lab/UxLab";
import { uxLabEnabled } from "../../../lib/ux-lab/flag";

/**
 * BRA-UX-04 — etkileşimli prototip (ADR-0004). Bayrak (`NEXT_PUBLIC_UX_LAB`) KAPALIYKEN bu rota 404 döner ve
 * hiçbir mevcut ekran etkilenmez. Bayrak istek anında okunur (`dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Prototip UX-04", robots: { index: false, follow: false } };

export default async function UxLabPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  if (!uxLabEnabled()) notFound();
  const { mode } = await searchParams;
  return <UxLab forceSample={mode === "sample"} />;
}
