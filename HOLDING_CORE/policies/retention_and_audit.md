# Data Retention & Audit Policy

## Audit Log
- **Every action is logged** — no exceptions
- Fields: actor, action, resource, resourceId, details, timestamp, IP
- Retention: 12 months active, then archived to cold storage
- Audit logs are immutable — no updates or deletes

## Activity Log Retention
| Data Type | Active Retention | Archive |
|-----------|-----------------|---------|
| Run steps & tool calls | 6 months | 24 months |
| Activity log | 12 months | 36 months |
| Memory items | Indefinite (until deprecated) | — |
| Content drafts | 6 months after publish | 12 months |
| CRM data | Indefinite | — |
| Usage meters | 24 months | 60 months |

## Audit Requirements
1. Every tool call logged to `tool_calls` table
2. Every run step includes `reasoning` field (MANDATORY)
3. Every CRUD operation logged to `activity_log`
4. Every approval decision logged with decider + timestamp
5. Cost tracked per run and per step

## Export
- Enterprise plan: full audit export (CSV/JSON)
- Pro plan: summary export
- Free plan: dashboard view only
