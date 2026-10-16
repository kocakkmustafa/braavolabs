# Ask: exact tenant model selection

The existing authenticated `POST /api/v1/research/cascade` remains automatic.
Its request, response, defaults and escalation behavior are unchanged.

## Discovery

`GET /api/v1/research/cascade/options` requires the same tenant authentication
as Ask, without a company ID. It returns `Cache-Control: private, no-store`:

```json
{
  "selectionContract": "exact-single-v1",
  "selections": [
    {"provider": "OPENAI", "model": "gpt-4o", "reasoningEfforts": []}
  ]
}
```

Options come from the existing tenant provider-link and Compare option builder.
No live provider/catalogue call or credential resolution occurs during discovery.
Ambiguous duplicate pairs and unusable links are omitted; an empty list is valid.
Only provider, model and supported effort metadata is serialized. This list is
advisory: execution resolves the current tenant configuration again.

## Selected execution

`POST /api/v1/research/cascade/selected` accepts:

```ts
{
  prompt: string; // 1..4000 characters
  selection: {
    provider: string;
    model: string;
    reasoningEffort?: "low" | "medium" | "high";
  };
  confidenceThreshold?: number; // 0..1
  secondOpinion?: false;
  budgetUsdCap?: number; // 0..10, existing post-attempt semantics
}
```

The request and nested selection are strict. Missing, unavailable, ambiguous,
non-canonical or unsupported choices return 400 before inference. Explicit effort
uses the existing exact positive capability profiles; omission preserves defaults.
`secondOpinion: true` is rejected. Authentication and rate limiting retain 401/429;
a selected request debits the same 20/hour tenant bucket as automatic cascade.

Execution uses exactly one resolved tenant link with `aiConfigOverride`, no tools,
one agent turn and the existing 1024 output-token default. There is no Compare,
synthesis, escalation or other provider/model fallback. Selected calls opt into a
provider-loop guard that rejects returned tool calls before any tool dispatch,
including unsolicited tool calls from a custom endpoint. Provider failure retains
existing error mapping. Existing adapter transport behavior is unchanged: this
promises one candidate invocation, not exactly one vendor HTTP request.

A successful result preserves all `TenantCascadeResult` fields and adds an exact
`selection` echo (effort absent when omitted). Top-level provider/model and the
sole attempt match that choice; `escalated` is false. A runner identity mismatch
returns 502 rather than reporting a selected success. This verifies the chosen
wire configuration; it cannot attest the model actually hosted by a vendor. Confidence, cost, rationale
and stopped-reason calculation remain those of the existing cascade runner.

`budgetUsdCap` does not guarantee a pre-call monetary ceiling. A first attempt can
exceed it, as in automatic mode; this feature neither increases limits nor adds a
hard spending reservation.

## Client compatibility

Offer explicit selection only after discovery returns `exact-single-v1`. Send an
explicit choice only to the selected path: older servers return 404, while the
legacy path strips unknown fields and could ignore a selection. On selected
400/404/provider/protocol failure, preserve the prompt and choice. Never silently
retry through automatic mode. Re-discover options after an unavailable choice.

Local acceptance uses real Express/JWT/tenant context/provider-link resolution and
cascade orchestration with synthetic persistence, Redis storage and inference.
It is not live-provider, production DB/RLS, deployment or mobile UI acceptance.
