/**
 * The column set every general audit-trail reader returns (BR-P1-005).
 *
 * This is EXACTLY the set an un-projected `findMany` returned before
 * ActivityLog gained `result` and `policy`, so applying it to the existing
 * readers is behaviour-preserving: every current consumer keeps receiving
 * precisely what it received before.
 *
 * The point is what happens NEXT. Prisma returns every scalar from an
 * un-projected read, so a new column is exposed everywhere the moment it is
 * added — which is how `result`/`policy` became MEMBER-readable through ten
 * readers that nobody had touched. Naming the columns makes each new one
 * opt-in per reader instead of opt-out.
 *
 * Deliberately excludes `result`/`policy` (whether a privileged attempt was
 * refused and under which rule) AND `details`/`ip` (free-form payload and
 * caller address). Those belong to the permission-gated audit view below.
 * Once slice B records denials, this boundary is what stops every member from
 * reading who was refused what, including denials naming themselves.
 */
export const ACTIVITY_FEED_SELECT = {
  id: true,
  tenantId: true,
  actor: true,
  action: true,
  resource: true,
  resourceId: true,
  createdAt: true,
} as const;

/**
 * The audit view: the feed plus the two columns that carry payload.
 *
 * `details` and `ip` are separated out because review demonstrated what the
 * member feed was actually handing over. Only 7 read-shaped suffixes are
 * filtered from it, so 130 of 135 distinct actions reach any MEMBER — and a
 * live row looked like this:
 *
 *   action:  "billing.payment_action_required"
 *   details: { email: "victim@example.com",
 *              hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_X/live_SECRET" }
 *   ip:      "203.0.113.9"
 *
 * Alongside it: an erased user's email and Stripe subscription id
 * (`user.delete_request`), third-party contact addresses (`outreach.email_sent`),
 * phone numbers (`voice.agent.create`) and raw prompt text
 * (`pipeline.created_from_nl`) — none of them read-shaped, all of them
 * MEMBER-visible, with an uncapped `offset`.
 *
 * The dashboard renders WHO did WHAT to WHICH resource; it was verified
 * against both clients that neither reads `details` or `ip`
 * (packages/ui/app/risks/page.tsx renders action/resource/actor/createdAt,
 * and the mobile home screen the same). So this is a leak closed, not a
 * feature removed.
 */
export const ACTIVITY_AUDIT_SELECT = {
  ...ACTIVITY_FEED_SELECT,
  details: true,
  ip: true,
} as const;

/**
 * Feed plus `details`, for readers scoped to ONE resource's own history.
 *
 * The pipeline revision view reconstructs `details.previousSteps` for a single
 * pipeline, so the payload is functionally required — and it is that
 * pipeline's own data, shown to someone who can already see the pipeline.
 * That is a different exposure from the tenant-wide feed, which is why it is
 * a different projection rather than a widening of the general one.
 *
 * Still no `ip`: no per-resource view needs the caller's address.
 */
export const ACTIVITY_REVISION_SELECT = {
  ...ACTIVITY_FEED_SELECT,
  details: true,
} as const;
