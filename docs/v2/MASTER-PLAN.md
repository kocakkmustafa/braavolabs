# Braavolabs v2 — Master Plan

> Status: **DRAFT v1** · 2026-06-01 · Owner: founder + Claude
> Source of truth for the v2 arc. Synthesised from a 10-agent recon (7 competitor clusters + 3 codebase gap analyses) and first-hand reads of the schema, run engine, importer, and BYOK router.

---

## 0. TL;DR

Braavolabs is **not** a greenfield build — it's already a mature (~80–90% aligned) BYOK multi-agent platform. v2 is about **closing six precise gaps**, **generalising** the opinionated "AI company" frame into a general automation/agent ecosystem, and **shipping the differentiators competitors don't have**.

**Positioning:** *"The command center for the agents you already have — build on the web, steer & approve from your pocket, run fully offline."* We compete on **control, mobility, privacy, and predictable price** — NOT on connector count (Zapier's 8k-app moat is unwinnable and beside the point).

**The moat, in defensible order (all validated as unserved by the field):**
1. **Two-way mobile pocket control + push** — no major platform ships a real native control app (Zapier never shipped one; n8n/Make/Lindy/Gumloop all web-only).
2. **Mid-run prompt injection / steer a specific agent + agent→human Q&A** — *nobody* does live re-steering; everyone does binary approve/deny. This is the sharpest moat.
3. **BYOK across 12 providers + one-toggle fully-offline Gemma** — breadth + true local/no-internet mode is a unique combination.
4. **Unify external automations (n8n/Make/Zapier) into one dashboard** — cross-platform monitoring is unserved; everyone is build-your-own-only.
5. **Predictable flat pricing + license freedom** — we own our engine (n8n's fair-code license forbids reselling), so we can embed/resell and price flat while BYOK keeps token cost on the user.

---

## 1. Vision (the 7 pillars)

1. Build automations/pipelines visually; control each agent; view live logs.
2. **HITL**: inject a new prompt to steer a specific agent mid-run; answer an agent's question; approve/deny steps.
3. **BYOK**: own API keys, pick LLM model/provider (OpenRouter-style multi-provider).
4. **Connect or build**: monitor+control existing automations from other platforms (n8n/Make/Zapier), or build natively.
5. **Mobile = pocket control**: logs, status, answer questions, send prompts (two-way), push.
6. **Fully-offline mode**: on-device latest Gemma, no internet, easy on/off toggle (cost + privacy).
7. **Web = setup/monitor · Mobile = pocket · optional CLI** installer.

---

## 2. Competitive landscape (condensed)

| Category | Players | Key finding |
|---|---|---|
| WF incumbents | n8n, Make, Zapier, Pipedream, Activepieces | Strong builders, **no mobile control plane**, shallow HITL (browser-bounce, hardcoded reviewers), **no mid-run steering**. n8n fair-code forbids resell. Make's Aug-2025 credit shift created pricing anxiety. |
| AI agent builders | Dify, Flowise, Langflow, **Sim**, Gumloop, Relevance, Lindy, Vellum | Sim = closest architectural twin (canvas + human-in-loop block + portal URL). Vellum = observability bar (replayable node traces). Langflow RCE (CVE-2025-3248) = sandbox user nodes. None do per-agent live steering or mobile. |
| OSS / CLI | CrewAI, AutoGPT Platform, **LangGraph**, OpenHands, Cline, Roo(dead), Ruflo, Goose | LangGraph `interrupt()`+checkpointer = the proven durable-HITL pattern to adopt. AutoGPT Platform = closest comp (visual blocks + marketplace + self-host). |
| Local / offline | Ollama, LM Studio, Jan, llama.cpp; **react-native-ai**, ExecuTorch, Cactus, **LiteRT-LM**, Gemma 3n | Desktop offline ≈ free (we already speak Ollama/LM Studio). Mobile: use **LiteRT-LM / react-native-ai**, NOT deprecated MediaPipe. **Gemma 3n E2B/E4B** (2–3GB RAM, 60–70 tok/s) is the target, ship 4-bit. |
| Observability/HITL | Langfuse, Phoenix, LangSmith, Helicone(maint.), Inngest, AG-UI | Adopt **AG-UI** event schema (one wire format for web+mobile+CLI), **LangGraph/Inngest** durable suspend/resume semantics, OTel/OpenInference spans (we have OTel). |
| BYOK security | OpenRouter, LiteLLM, Vercel AI GW, OpenBao, OpenMeter | **Envelope encryption** (per-tenant DEK wrapped by KEK in OpenBao Transit) + JIT in-memory decrypt; LiteLLM Org→Team→User→Key cascading budgets; OpenMeter→Stripe metering. |

**"openclaw / nemoclaw" resolved (the founder's references):** "claude clawbot" → Clawdbot (Nov-2025, P. Steinberger) → renamed → **OpenClaw** (self-hosted personal AI assistant controlled via messaging apps, ~247k★, BYOK incl. offline Ollama). **NemoClaw** = NVIDIA's on-prem wrapper. → **Our repo already has import adapters for both.** OpenClaw validates the "control agents from your phone" thesis at massive scale, but it's single-user/CLI with no visual builder, team approvals, or external-platform aggregation — exactly the gap our dashboard + Expo app fills.

---

## 3. Target personas

1. **Non-coder SMB owner** — "I don't understand how to use it" is the #1 AI-adoption blocker; fears runaway bills. → HITL + flat pricing + mobile + NL builder.
2. **Pro/agency operator** — runs many client automations, monitors on the go, hates per-seat scaling. → cross-platform dashboard + pocket control.
3. **Privacy/regulated buyer (EU, health, legal, finance)** — data must never leave device. → offline Gemma + AES bundles + BYOK. (Strong macro tailwind: EU sovereign-cloud spend, local-first enforcement.)
4. **Cost-conscious power user** — fled n8n free-tier removal / Zapier bills. → BYOK + self-host + offline.

---

## 4. Where we are (codebase reality — the strong base)

40+ Prisma tables, 32 API modules. **Already built:** sequential+parallel+hierarchical pipeline execution (BullMQ), runs/run_steps/tool_calls with mandatory reasoning + rollback/rerun, 5 risk stops (`governance/engine.ts`), spend approvals with pause/resume, **12-provider BYOK router** (`services/ai-client.ts`, SSRF guard, `OFFLINE_MODE` cloud-block, AES-256-GCM scrypt per-row keys), `/hooks` HMAC webhook fan-in, **automation-importer** (n8n/claude/openclaw/nemoclaw/mcp/generic), **MCP Connector marketplace** tables, **machine-bound encrypted offline bundle** (HKDF + license JWT), VoiceAgents, Bench, Template marketplace, WebResearch, SSO, Expo mobile app (auth/approvals/drafts/push all working), Stripe+IAP, 6-locale i18n, OTel+Sentry.

**Strategic reframe:** keep the engine; generalise the top layer. `Agent` is already generic (role+systemPrompt+tools+model); the 9 primitives are a *Company-level tag*, not an Agent lock. **"AI Company" becomes the flagship template/onboarding path, not the only product.**

---

## 5. The precise gap map (ranked — validated by research + code)

### GAP 1 — Mid-run steering & agent↔human Q&A (P2) · **the moat**
- `agent/claude.ts` runAgentLoop is a **closed `for(turn)` loop** — never re-reads run status or drains an operator message mid-flight. `ApprovalType` is **SPEND-only**. No inject/steer/intervene anywhere (grep-confirmed).
- Web: `approvals/page.tsx` is binary approve/reject, no note/edit; no intervention surface on any run view.
- Mobile: no question/reply/chat; `triggerRun` passes empty `input`.

### GAP 2 — Real-time + pipeline editor + visual builder (P1)
- "SSE" is actually **3s Postgres polling** (`run/router.ts:~179`), coarse step status only; resume **replays from step-group 0** (claimed idempotency keys not implemented).
- UI: **no `/pipelines/[id]` route at all** (importer's success link 404s); pipelines are view/trigger-only (not editable); `createPipelineFromNL` + `nlEditPreview/Apply` exist in `lib/api.ts` with **zero UI callers**; run detail polls 2s instead of using SSE; **no drag-drop canvas** (no reactflow/@xyflow/dnd-kit).
- Mobile: `workflows/[id]` shows **faked** progress; `api.getRun` defined but unused.

### GAP 3 — Connect + monitor live external automations (P4)
- Today: import-once (lossy snapshot) + 26 outbound adapters + n8n **fire-and-forget trigger** (no callback) + inbound `/hooks`. **No pull-based poller** to mirror an external system's live run state. MCP Connector runtime proxy is "largely scaffolding"; import→runnable (agent/tool resolution) is a TODO.

### GAP 4 — Per-agent provider + fallback (P3)
- Provider/key is **per-tenant** (`UserAIConfig @unique tenantId`); model varies per agent but provider+key is globally fixed; **no fallback chain**. UI model lists are hardcoded/stale (9 shown vs 12; Gemini 2.x missing) — `getAIConfig().supportedProviders` is returned but unused.

### GAP 5 — Offline runtime + mobile on-device Gemma (P6)
- The offline **execution runtime SDK lives outside the repo** — we can *produce* the encrypted bundle but not *run* it with in-repo code. Mobile is **100% cloud** — zero on-device inference, no offline toggle, no domain-data cache (backgrounding loses state).

### GAP 6 — CLI (P7)
- `scripts/install.sh` is an installer, not a CLI. No `braavo run/agent/deploy` command surface.

---

## 6. Target architecture (extend, don't replace)

- **Event schema:** adopt **AG-UI** typed events (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, `STATE_DELTA`, lifecycle) as the single wire format for web + mobile + CLI.
- **Real-time transport:** **SSE for live logs** (driven by BullMQ `QueueEvents` → Redis pub/sub, replacing DB polling) + **WebSocket/push for two-way** mobile steering. nginx: `proxy_buffering off`, `proxy_read_timeout 600s`, Last-Event-ID resume cursor.
- **Durable HITL:** model 3 interrupt types as DB rows with status `awaiting_human` — (1) approve/deny step, (2) agent-asks-question (free-text), (3) inject/steer (prompt → specific `agent_id`). Resume = HTTP POST re-enqueues the BullMQ job from a persisted checkpoint (LangGraph `interrupt()` / Inngest `waitForEvent` semantics; keep BullMQ). Offload large prompt/response blobs to Postgres/S3, store references.
- **Observability:** emit OTel/OpenInference spans from runs/run_steps (run→agent→step→LLM/tool), surface TTFT + tokens/sec; export to Langfuse/Phoenix without lock-in. Target Vellum-grade replayable traces.
- **BYOK security:** keep AES-256-GCM as the ciphertext layer; add **envelope encryption** — per-tenant DEK wrapped by a KEK in **OpenBao Transit** (MPL-2.0, self-hostable on Lightsail). JIT decrypt in worker memory only; never log/stream. LiteLLM-style Org→Team→User→Key + cascading budgets as the schema reference; OpenRouter-style Prioritized/Fallback ordering.
- **Metering:** OpenMeter (self-hosted) for token metering; pre-flight budget gate in BullMQ; Stripe for overage.
- **Offline:** desktop = Ollama/LM Studio BYOK (done). Mobile = **react-native-ai** (Vercel AI SDK parity, mirrors our tool/stream abstractions) on **LiteRT-LM**; **Gemma 3n E2B/E4B** 4-bit, post-install download into the machine-bound encrypted bundle; scope offline to single-agent/summarisation (tool-calling is fragile at 2–4B). Ship the **offline runtime SDK in-monorepo**.
- **Security hardening:** sandbox any user-authored/code nodes from day one (Langflow RCE lesson).

---

## 7. Phased roadmap

> Each phase ships independently and is value-ordered. Production mutations (DB migrate, Stripe, deploy) get an explicit go/no-go; code/local work proceeds autonomously. Every new user-facing string lands in all 6 locales; pricing stays sourced from `PLAN_PRICING`.

### Phase 0 — Foundations & correctness (unblock everything)
- Real-time run stream: BullMQ `QueueEvents` → Redis pub/sub → SSE (replace 3s polling in `run/router.ts`).
- Add `/pipelines/[id]` route (read-only run/pipeline detail); fix the importer 404 link; swap web run-detail polling → SSE.
- **Surface the already-built NL endpoints** (`createPipelineFromNL`, `nlEditPreview/Apply`) in the UI — highest value-per-effort (built, hidden).
- Define the AG-UI event vocabulary in `packages/core`.

### Phase 1 — The moat: mid-run steering + HITL Q&A (P2)
- DB: `SteeringMessage` model + `ApprovalType.INPUT|QUESTION|STEER`; `Run.resumeCursor`.
- Engine: status re-check + operator-message drain at the **top of the turn loop** in `agent/claude.ts`; `ask_user`/`request_input` tool → interrupt row → push.
- Web: run-timeline intervention surface (ask-the-human inbox, free-text reply, "steer this agent", approve-with-note/edit-payload).
- Resume from checkpoint carrying the injected prompt.

### Phase 2 — Pocket control completeness (P5)
- Mobile run-detail screen (real steps + reasoning + tool calls), real-time (SSE/WS), **send-prompt** + **answer-question** + steer surfaces; push deep-links to them; offline domain cache (persist beyond auth).

### Phase 3 — Connect & monitor external (P4)
- Pull-based connector poller (cron → n8n/Make/Zapier execution APIs → mirror into runs/run_steps); finish MCP proxy runtime; import→runnable (agent/tool resolution); add Make + Zapier adapters.

### Phase 4 — Offline-first (P6)
- Ship offline runtime SDK in-monorepo (decrypt+execute bundle); mobile on-device Gemma 3n via react-native-ai/LiteRT-LM; one-toggle online/offline; model download into encrypted bundle.

### Phase 5 — Depth + polish + launch
- Per-agent provider override + fallback chain (P3); drive model lists from live API.
- Visual DAG builder (React Flow) — read-only first, then editable (P1).
- Thin CLI `braavo run/agent/deploy` (P7).
- **Pricing/positioning reframe** (see §9); security (OpenBao envelope, node sandbox); launch-readiness (App Store metadata gaps, Play); full i18n sweep.

---

## 8. Security model
- Envelope encryption (per-tenant DEK + OpenBao KEK); AES-256-GCM ciphertext; JIT in-memory decrypt; secrets never logged/streamed; redacted in observability.
- Tenant isolation on every query (existing rule #10). Per-tenant CMK for enterprise later.
- Sandbox user-authored/code/connector nodes (Langflow RCE lesson); MCP connector manifest signature verification (table already exists).
- HMAC + replay-window on all inbound webhooks (existing).

## 9. Pricing & positioning reframe
- **Charge for control surface + orchestration, not tokens** (BYOK = token cost is the user's). Flat tiers, **not per-seat** (seats break in the agent era).
- Direction (validate, keep `PLAN_PRICING` as the single source): Free (1–2 pipelines, community/offline) → Pro ~$19–29 solo → **Team flat ~$49–79** (undercut Zapier Team's $69.50/seat) → **Private/Offline** tier (one-time license or paid; costs us nothing) → Enterprise (SSO/SLA, exists).
- Reframe limits from company/channel → **workspace/automation/connector**.
- Naming/positioning: "command center / control tower / cockpit," Private/Local themes. Avoid flow/loop/zap.

## 10. Risks & mitigations
- **On-device agents fragile at 2–4B** → scope offline to single-agent/summarisation; keep cloud for complex pipelines.
- **App-size bloat from bundled model** → post-install download into encrypted bundle.
- **OSS-agent fragility** (Roo Code shut down) → own the runtime, no hard upstream dependency.
- **External-platform APIs vary** → adapter pattern, fail-soft, degrade to webhook-only where no poll API.
- **Scope creep** → ship phases independently; each is launch-safe on its own.

## 11. Open questions for the founder (non-blocking — sensible defaults chosen)
1. Keep "AI Company" as flagship template on top of the general engine? *(default: yes)*
2. Pricing: adopt flat Team tier + Private/offline tier now, or after Phase 4? *(default: reframe at Phase 5 launch)*
3. Mobile offline model: Gemma 3n E4B (better) vs E2B (fits more devices)? *(default: ship E2B, offer E4B download)*
4. CLI priority — is a Claude-Code-style interactive CLI in-scope for first launch, or post-launch? *(default: post-launch, Phase 5 thin CLI only)*

## 12. Immediate next steps (Phase 0)
1. `packages/core` — define AG-UI event types + a shared `runEvents` contract.
2. `run/router.ts` — replace 3s polling with BullMQ `QueueEvents`→Redis pub/sub→SSE.
3. `packages/ui/app/pipelines/[id]/page.tsx` — new route (read-only detail), fix importer 404 link, switch run detail to SSE.
4. Surface `createPipelineFromNL` / `nlEditPreview` in the UI (NL create + edit).
