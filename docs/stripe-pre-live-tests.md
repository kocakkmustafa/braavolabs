# Stripe Pre-Live Test Scenarios

**Run these 5 scenarios in Stripe TEST mode before flipping to LIVE.**
Each scenario validates a different webhook → DB plan-mapping path.
Watching for: tier mapping correctness, idempotency, webhook signature
verification, and downgrade-on-cancel behavior.

---

## Setup (one-time)

1. **Use Stripe test mode** — toggle the dashboard to "Test mode"
2. **Use a test card**: `4242 4242 4242 4242` exp=`12/34` cvc=`123`
3. **Use a test user account** on production — register a fresh email
   (e.g. `kaan+stripe-test-1@gmail.com`)
4. **Watch the activity log** in real time:
   ```bash
   ssh -i ~/.ssh/id_ed25519 ubuntu@63.180.74.27 \
     'sudo docker logs aicos-api -f 2>&1 | grep -iE "stripe|webhook|plan|tenant"'
   ```
5. **Watch the idempotency table**:
   ```bash
   watch -n 2 'ssh -i ~/.ssh/id_ed25519 ubuntu@63.180.74.27 \
     "sudo docker exec aicos-postgres psql -U aicos -d aicos_prod -c \
       \"SELECT type, processed_at, created_at FROM stripe_webhook_events \
        ORDER BY created_at DESC LIMIT 10\""'
   ```

---

## Scenario 1 — FREE → CREATOR upgrade (happy path)

**Steps:**
1. Login as test user (FREE plan)
2. Go to `/pricing` → click "Upgrade to Creator (monthly)"
3. Enter card `4242...` and complete checkout
4. Wait for redirect back to `/billing` page

**Expected:**
- ✅ `stripe_webhook_events` shows TWO rows: `checkout.session.completed` + `customer.subscription.created` (or `.updated`)
- ✅ Both rows have `processed_at` populated within 5 seconds of `created_at`
- ✅ `tenants.plan = 'CREATOR'`, `stripe_customer_id` and `stripe_subscription_id` populated
- ✅ Activity log: `billing.subscription_created` entry
- ✅ User now sees "Creator" badge on `/billing`

**SQL verification:**
```sql
SELECT t.email, t.plan, t.stripe_customer_id, t.stripe_subscription_id
FROM tenants t WHERE t.email LIKE '%stripe-test%';

SELECT type, processed_at, result_summary FROM stripe_webhook_events
ORDER BY created_at DESC LIMIT 5;

SELECT action, details, created_at FROM activity_log
WHERE action LIKE 'billing%' ORDER BY created_at DESC LIMIT 5;
```

---

## Scenario 2 — Plan upgrade CREATOR → PRO

**Steps:**
1. Same user as Scenario 1 (already on Creator)
2. Go to `/billing` → "Manage subscription" → opens Stripe Customer Portal
3. Click "Update plan" → choose "Pro" → confirm

**Expected:**
- ✅ One `customer.subscription.updated` webhook with new price ID
- ✅ `tenants.plan = 'PRO'` (logger should print plan-mapping log)
- ✅ Self-hosted LLM should now unlock (previously gated to CREATOR+ already, but verify the gate doesn't reject)
- ✅ `usage_meters` for the current month carry over (no reset on tier change)

**Verify the price-ID mapping:**
- Watch the `aicos-api` logs for `Stripe webhook: unknown price ID — keeping tenant on FREE plan`. **If you see this, your test-mode env vars are wrong** — production env has live price IDs but you're in test mode now. To run this test you need to either:
  - (Option A, recommended) Add test-mode env vars under feature flag — set BYPASS_BILLING=false but populate `STRIPE_*_PRICE_ID` from test mode dashboard
  - (Option B) Spin up a staging environment with test-mode keys

---

## Scenario 3 — Cancel subscription (mid-period)

**Steps:**
1. Same user (now on PRO)
2. Stripe Customer Portal → "Cancel subscription"
3. Stripe sends `customer.subscription.updated` with `cancel_at_period_end=true`
4. Wait until end of billing period OR fast-forward via Stripe CLI:
   ```bash
   stripe trigger customer.subscription.deleted
   ```

**Expected:**
- ✅ Immediately after click: `tenants.plan` STILL `PRO` (cancel-at-period-end means access continues till end of period)
- ✅ At period end: `customer.subscription.deleted` webhook → `tenants.plan = 'FREE'`
- ✅ Self-hosted LLM gate now blocks (test by visiting `/settings` → AI Provider → try to select Ollama → should see "upgrade to Creator" CTA)

**Edge cases:**
- Race condition: subscription.deleted webhook fires while user is mid-pipeline → governance engine should NOT block in-flight runs, just future ones
- Verify `current_period_end` is captured in subscription metadata for UI display

---

## Scenario 4 — Reactivate after cancel (within grace period)

**Steps:**
1. Same user, now on FREE after Scenario 3
2. `/pricing` → upgrade to Creator again

**Expected:**
- ✅ New `customer` Stripe object reuses existing `stripe_customer_id` (Stripe doesn't create duplicates for the same email — verify by checking Stripe dashboard)
- ✅ New subscription created, new `stripe_subscription_id` written
- ✅ `tenants.plan = 'CREATOR'` again
- ✅ Old subscription's `subscription.deleted` event already processed and idempotent — re-running it from Stripe CLI should NOT downgrade the tenant again:
   ```bash
   stripe events resend evt_xxxxxxxxxxxxx
   ```

**Idempotency check:**
- Re-trigger any of Scenarios 1-3 webhook events via `stripe events resend evt_xxx`
- `stripe_webhook_events` should show the original row with NO new row added (UNIQUE constraint catches it)
- Webhook handler should return `{ received: true, duplicate: true }` — visible in API logs as `Stripe webhook duplicate — skipped`

---

## Scenario 5 — Payment failure → soft downgrade

**Steps:**
1. Fresh test user, upgrade to Creator with card `4000 0000 0000 0341` (Stripe's "decline after attach" test card)
2. After initial successful charge, the next renewal fails

**Expected:**
- ✅ `invoice.payment_failed` webhook → tenant gets a "payment retry" grace period (Stripe tries 3-4 times over a week)
- ✅ During grace period: `tenants.plan` should STILL be CREATOR (don't downgrade on first failure — bad UX)
- ✅ After Stripe gives up: `customer.subscription.deleted` → `tenants.plan = 'FREE'`
- ✅ Email notification to user (if SendGrid configured) about payment failure

**Manual fast-path:**
```bash
# Skip the wait — trigger payment_failed directly
stripe trigger invoice.payment_failed
```

**Critical question for product:** what's the policy on partial-month
refunds when a customer cancels mid-cycle? Currently we DON'T issue
refunds — they keep access until period end. Confirm this is intentional
before launch.

---

## Stripe webhook signature verification (security)

Run once before going live:

```bash
# Send a webhook with WRONG signature — should be rejected
curl -X POST https://braavolabs.com/api/v1/billing/webhook \
  -H "Stripe-Signature: t=12345,v1=invalid_signature" \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_fake","type":"customer.subscription.created","data":{}}'

# Expected: HTTP 400 with {"error": "Invalid signature"}
```

If this returns 200 or processes the fake event, **DO NOT GO LIVE** —
signature verification is broken and anyone can downgrade/upgrade
tenants by spoofing webhooks.

---

## Going live — final checklist

- [ ] All 5 scenarios pass in test mode
- [ ] Idempotency verified (resend webhook → no duplicate processing)
- [ ] Signature verification rejects bad signatures (HTTP 400)
- [ ] All `STRIPE_*_PRICE_ID` env vars updated to **live** mode IDs (not test)
- [ ] `STRIPE_SECRET_KEY` updated to live mode secret (`sk_live_...` not `sk_test_...`)
- [ ] `STRIPE_WEBHOOK_SECRET` updated to live mode webhook signing secret
- [ ] BYPASS_BILLING=false (already enforced by env validation in production)
- [ ] Stripe webhook endpoint URL configured in Stripe Dashboard (live mode):
      `https://braavolabs.com/api/v1/billing/webhook`
- [ ] Subscribe to required events in Stripe webhook config:
      - `checkout.session.completed`
      - `customer.subscription.created`
      - `customer.subscription.updated`
      - `customer.subscription.deleted`
      - `invoice.payment_failed`
      - `invoice.payment_succeeded` (optional)
- [ ] Customer portal configured in Stripe Dashboard:
      enable plan switching, cancel, payment method update
- [ ] Add Stripe → Slack integration for live monitoring (optional)
- [ ] Communicate maintenance window to existing FREE users (none yet, but plan for it)
- [ ] Restore-from-backup drill confirmed in last 30 days

When all items checked → ready for live mode.
