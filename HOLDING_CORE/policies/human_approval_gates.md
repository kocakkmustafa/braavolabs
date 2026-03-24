# Human Approval Gates

## Core Principle
**Only spend actions require human approval.** All other autonomous actions are allowed.

## What Requires Approval
1. **Financial transactions** — any action that spends money
   - Sending paid ads
   - Purchasing services
   - Upgrading subscriptions
   - Any API call with cost > $0

2. **Approval Flow**
   - Run pauses automatically when spend action is detected
   - Approval request created with description + amount
   - User notified via dashboard + email
   - Run resumes on APPROVED, cancels on REJECTED
   - Approvals expire after 72 hours → auto-reject

## What Does NOT Require Approval
- Content creation and drafting
- Data analysis and reporting
- CRM contact management
- Memory storage and retrieval
- Pipeline execution (non-financial)
- Outreach messages (email/social)
- Webhook processing
