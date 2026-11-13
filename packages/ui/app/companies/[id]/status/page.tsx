import { notFound } from "next/navigation";
import CompanyStatus from "../../../../components/companies/CompanyStatus";
import { uxCompanyEnabled } from "../../../../lib/ux-company/flag";

/**
 * BRA-UX-05f — Şirket durumu (E10): tek satır özet + ajanlar. Bayrak (`NEXT_PUBLIC_UX_COMPANY`) KAPALIYKEN rota yok sayılır (404);
 * bayrak istek anında okunur (`force-dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default function CompanyStatusPage() {
  if (!uxCompanyEnabled()) notFound();
  return <CompanyStatus />;
}
