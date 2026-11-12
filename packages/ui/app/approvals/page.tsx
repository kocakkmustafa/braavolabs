import ApprovalCenter from "../../components/approvals/ApprovalCenter";
import ApprovalsLegacy from "../../components/approvals/ApprovalsLegacy";
import { showApprovalCenter, uxApprovalsEnabled } from "../../lib/ux-approvals/flag";

/**
 * BRA-UX-05i — Onay ve güvenlik merkezi. Bayrak (`NEXT_PUBLIC_UX_APPROVALS`) KAPALIYKEN eski onay sayfası (`ApprovalsLegacy`) birebir
 * sunulur; açıkken sheet'li yeni ekran (ADR-0004). `?view=classic` bayrak açıkken de eski sayfayı verir. Bayrak istek anında okunur
 * (`force-dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams;
  return showApprovalCenter(uxApprovalsEnabled(), view) ? <ApprovalCenter /> : <ApprovalsLegacy />;
}
