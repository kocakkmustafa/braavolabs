import InboxLegacy from "../../components/inbox/InboxLegacy";
import JobsInbox from "../../components/inbox/JobsInbox";
import { uxJobsEnabled } from "../../lib/ux-jobs/flag";

/**
 * BRA-UX-05c — İşler. Bayrak (`NEXT_PUBLIC_UX_JOBS`) KAPALIYKEN eski gelen kutusu (`InboxLegacy`) birebir sunulur;
 * açıkken 4 kovalı İşler omurgası (ADR-0004). Bayrak istek anında okunur (`dynamic`), derleme anında gömülmez.
 */
export const dynamic = "force-dynamic";

export default function InboxPage() {
  return uxJobsEnabled() ? <JobsInbox /> : <InboxLegacy />;
}
