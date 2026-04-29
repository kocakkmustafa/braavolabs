import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Documentation",
  description:
    "Public REST API reference for Braavolabs — auth, companies, pipelines, runs, agents, memory, billing, webhooks. JWT authentication with bearer tokens. 127 endpoints across 21 modules.",
  alternates: { canonical: "https://braavolabs.com/docs" },
  openGraph: {
    title: "Braavolabs API Documentation",
    description: "127 REST endpoints, JWT auth, webhooks, SSE streaming. Build on the autonomous company platform.",
    type: "article",
  },
};

/**
 * Public API documentation page.
 *
 * This is the source of truth developers (Persona 4 from the launch UX audit)
 * will hit before deciding whether to integrate. We list every public-surface
 * endpoint with method + path + auth requirement + body shape so a procurement
 * conversation can start without a sales call.
 *
 * Server-rendered (no "use client") to keep the rendered HTML crawlable —
 * AI agents querying the docs page (ChatGPT, Claude, Perplexity) get the
 * full content, not just a JS shell.
 */
export default function DocsPage() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0d14", color: "#e1e2eb" }}>
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <a href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm">Braavolabs</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/features" className="hover:text-white transition-colors">Features</a>
          <a href="/marketplace" className="hover:text-white transition-colors">Templates</a>
          <a href="/pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            Get Started
          </a>
        </div>
      </nav>

      <main className="max-w-[920px] mx-auto px-6 py-12">
        <header className="mb-10">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}
          >
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>
              API REFERENCE — v0.1.0
            </span>
          </div>
          <h1 className="font-headline font-extrabold mb-3" style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)", lineHeight: 1.1 }}>
            Braavolabs REST API
          </h1>
          <p style={{ color: "#bbc9cf", maxWidth: 620, lineHeight: 1.6 }}>
            127 endpoints across 21 modules — auth, companies, pipelines, runs, agents,
            memory, billing, webhooks. JWT bearer auth on every request. Server-Sent
            Events for live run streaming. HMAC-signed webhooks. Generated docs at the
            bottom show every route the production server exposes today.
          </p>
        </header>

        {/* TOC */}
        <nav aria-label="Table of contents" className="mb-12 p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <p className="font-semibold text-sm mb-3">On this page</p>
          <ul className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm" style={{ color: "#a4e6ff" }}>
            <li><a href="#auth" className="hover:underline">Authentication</a></li>
            <li><a href="#base-url" className="hover:underline">Base URL & Errors</a></li>
            <li><a href="#rate-limits" className="hover:underline">Rate Limits</a></li>
            <li><a href="#auth-routes" className="hover:underline">Auth endpoints</a></li>
            <li><a href="#companies-routes" className="hover:underline">Companies</a></li>
            <li><a href="#pipelines-routes" className="hover:underline">Pipelines</a></li>
            <li><a href="#runs-routes" className="hover:underline">Runs &amp; Steps</a></li>
            <li><a href="#agents-routes" className="hover:underline">Agents</a></li>
            <li><a href="#memory-routes" className="hover:underline">Memory</a></li>
            <li><a href="#approvals-routes" className="hover:underline">Approvals</a></li>
            <li><a href="#billing-routes" className="hover:underline">Billing</a></li>
            <li><a href="#growth-routes" className="hover:underline">Growth &amp; Referral</a></li>
            <li><a href="#integrations-routes" className="hover:underline">Integrations</a></li>
            <li><a href="#webhooks" className="hover:underline">Webhooks</a></li>
            <li><a href="#sse" className="hover:underline">SSE Streaming</a></li>
            <li><a href="#sdk" className="hover:underline">SDK &amp; CLI</a></li>
            <li><a href="#local-llm" className="hover:underline">Self-hosted LLM (Gemma)</a></li>
            <li><a href="#skills-library" className="hover:underline">Skills Library</a></li>
            <li><a href="#security" className="hover:underline">Security</a></li>
            <li><a href="#changelog" className="hover:underline">Changelog</a></li>
          </ul>
        </nav>

        {/* === Authentication === */}
        <Section id="auth" title="Authentication">
          <p>
            All requests except <code>POST /auth/login</code>, <code>POST /auth/register</code>,
            and <code>POST /auth/forgot-password</code> require a JWT access token in the{" "}
            <code>Authorization: Bearer &lt;token&gt;</code> header. Tokens expire in 1 hour;
            use the refresh token to mint a new pair.
          </p>
          <Code language="bash">{`# Login → access + refresh token
curl -X POST https://braavolabs.com/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"..."}'

# Response
{
  "token":        "eyJhbGciOiJIUzI1NiIs...",  // 1h
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",  // 7d, single-use
  "user":   { "id": "...", "email": "...", "role": "OWNER" },
  "tenant": { "id": "...", "name": "...", "plan": "FREE" }
}

# Authenticated request
curl https://braavolabs.com/api/v1/companies \\
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIs...'

# Refresh expired access token
curl -X POST https://braavolabs.com/api/v1/auth/refresh \\
  -H 'Content-Type: application/json' \\
  -d '{"refreshToken":"..."}'`}</Code>
          <p className="text-sm" style={{ color: "#859399" }}>
            Refresh tokens rotate on every use — the old token is revoked the moment a new pair is issued.
            JWTs are signed with HS256 (server-side secret) and pinned to the algorithm at verification time.
            Google OAuth is also available via <code>/auth/google/url</code>.
          </p>
        </Section>

        {/* === Base URL & Errors === */}
        <Section id="base-url" title="Base URL, Versioning & Errors">
          <p>Production API base: <code>https://braavolabs.com/api/v1</code></p>
          <p>
            All endpoints return JSON. Errors follow this shape:
          </p>
          <Code language="json">{`{
  "error": "Validation failed",
  "message": "email: Invalid email",
  "statusCode": 400,
  "issues": [{ "validation": "email", "code": "invalid_string", "path": ["email"] }]
}`}</Code>
          <Table headers={["HTTP", "When", "Body"]}>
            <Row>200 / 201<EOR />Success<EOR />resource (or empty for 204)</Row>
            <Row>400<EOR />Zod validation failure<EOR /><code>{`{ error, message, issues[] }`}</code></Row>
            <Row>401<EOR />Missing / invalid / expired JWT<EOR /><code>{`{ error: "Unauthorized" }`}</code></Row>
            <Row>403<EOR />Authenticated but not allowed (cross-tenant, role)<EOR /><code>{`{ error: "Forbidden" }`}</code></Row>
            <Row>404<EOR />Resource missing or hidden by tenant scope<EOR /><code>{`{ error: "Not found" }`}</code></Row>
            <Row>429<EOR />Per-IP or per-user rate limit hit<EOR /><code>x-ratelimit-*</code> headers + <code>Retry-After</code></Row>
            <Row>5xx<EOR />Internal — Sentry-tracked<EOR /><code>{`{ error, requestId }`}</code></Row>
          </Table>
        </Section>

        {/* === Rate Limits === */}
        <Section id="rate-limits" title="Rate Limits">
          <p>
            Buckets are per-IP for unauthenticated routes and per-user for authenticated ones.
            Every response carries <code>x-ratelimit-limit</code> and <code>x-ratelimit-remaining</code> headers.
          </p>
          <Table headers={["Bucket", "Limit", "Window"]}>
            <Row>auth (login / register / forgot)<EOR />5<EOR />15 min</Row>
            <Row>build-start (NL company builder)<EOR />10<EOR />1 min</Row>
            <Row>build-answer (clarification turn)<EOR />30<EOR />1 min</Row>
            <Row>run-trigger (manual pipeline run)<EOR />30<EOR />1 min</Row>
            <Row>natural-language-builder (pipeline-from-NL)<EOR />10<EOR />1 min</Row>
            <Row>standard authenticated<EOR />100<EOR />1 min</Row>
          </Table>
          <p className="text-sm" style={{ color: "#859399" }}>
            5 consecutive failed logins lock the account for 30 minutes (Redis-backed). Quota
            limits per plan (free = 10 runs/month) are enforced separately at billing layer.
          </p>
        </Section>

        {/* === Auth Routes === */}
        <Section id="auth-routes" title="Auth endpoints">
          <RouteList prefix="/api/v1/auth" routes={[
            ["POST", "/register", "Public", "Create tenant + user. Body: { email, password, name, tenantName, ref? }. Returns token pair + user + tenant. Disposable email domains blocked."],
            ["POST", "/login", "Public", "Body: { email, password }. Account lockout after 5 failures."],
            ["POST", "/refresh", "Public", "Body: { refreshToken }. Returns new token pair, revokes old."],
            ["POST", "/logout", "Auth", "Revokes the active refresh token."],
            ["POST", "/forgot-password", "Public", "Body: { email }. Always returns 200 (no enumeration). Mail sent async."],
            ["POST", "/reset-password", "Public", "Body: { token, newPassword }. Token single-use, 1h TTL."],
            ["GET", "/google/url", "Public", "Returns Google OAuth authorization URL. State param required to bind callback."],
            ["GET", "/google/callback", "Public", "OAuth code exchange. Find or create user. Returns token pair."],
          ]} />
        </Section>

        {/* === Companies === */}
        <Section id="companies-routes" title="Companies (21 endpoints)">
          <p>An AI company is a primitive collection (Acquisition / Sales / Delivery / Content / Operations / Finance / Analytics / Memory / Governance) plus the agents that staff each.</p>
          <RouteList prefix="/api/v1/companies" routes={[
            ["GET", "/", "Auth", "List tenant companies."],
            ["POST", "/", "Auth", "Create directly with full spec. Most users prefer /build for natural language."],
            ["GET", "/:id", "Auth", "Tenant-scoped fetch."],
            ["PATCH", "/:id", "Auth", "Update channels, status, brand voice. Strict allowlist on config."],
            ["DELETE", "/:id", "Auth (OWNER)", "Cascade delete: pipelines + runs + agents + drafts."],
            ["POST", "/:id/pause", "Auth", "Halt all pipelines for this company."],
            ["POST", "/:id/resume", "Auth", "Re-enable scheduled runs."],
            ["POST", "/build", "Auth (rate-limited 10/min)", "Body: { description }. Starts a builder session — Claude generates spec + clarification questions."],
            ["POST", "/build/:sessionId/answer", "Auth", "Body: { answer }. Up to 3 clarification turns."],
            ["POST", "/build/:sessionId/confirm", "Auth", "Finalizes session → real company + default pipeline."],
            ["GET", "/build/:sessionId", "Auth", "Get current builder state."],
            ["GET", "/:id/agents", "Auth", "List agents (one per primitive)."],
            ["POST", "/:id/agents", "Auth", "Add a custom agent."],
            ["PATCH", "/:companyId/agents/:agentId", "Auth", "Update prompt / role / tools / budget."],
            ["DELETE", "/:companyId/agents/:agentId", "Auth", "Remove agent (soft-delete)."],
            ["POST", "/:companyId/agents/:agentId/nl-edit", "Auth", "Body: { instruction }. Claude proposes a diff for the agent's system prompt."],
            ["POST", "/:companyId/agents/:agentId/nl-edit/apply", "Auth", "Apply the proposed diff."],
            ["GET", "/:id/activity", "Auth", "Activity log (last 100 by default)."],
            ["GET", "/:id/contacts", "Auth", "CRM contacts created by outreach pipelines."],
            ["GET", "/:id/deals", "Auth", "CRM deals, with stage."],
            ["GET", "/:id/webhooks", "Auth", "Inbound webhook URLs for this company."],
          ]} />
        </Section>

        {/* === Pipelines === */}
        <Section id="pipelines-routes" title="Pipelines (7 endpoints)">
          <p>A pipeline is an ordered list of steps (each runs an agent or tool). Steps with the same <code>order</code> run in parallel.</p>
          <RouteList prefix="/api/v1/pipelines" routes={[
            ["GET", "/", "Auth", "Filter by ?companyId. Empty array if no match."],
            ["POST", "/", "Auth", "Create with { companyId, name, steps[], schedule? }."],
            ["GET", "/:id", "Auth", "Pipeline detail with steps + last run."],
            ["PATCH", "/:id", "Auth", "Update steps / schedule / enabled."],
            ["DELETE", "/:id", "Auth", "Soft-delete + halt scheduled triggers."],
            ["POST", "/:id/run", "Auth (rate-limited 30/min)", "Body: { input?, budget? }. Returns 201 with { id, status: 'PENDING', jobId }. Run executes async."],
            ["POST", "/from-natural-language", "Auth (rate-limited 10/min)", "Body: { prompt }. Claude generates a pipeline draft. Caps generated steps at 8."],
          ]} />
        </Section>

        {/* === Runs === */}
        <Section id="runs-routes" title="Runs &amp; Steps (7 endpoints)">
          <RouteList prefix="/api/v1/runs" routes={[
            ["GET", "/:id", "Auth", "Run detail: { status, error, costUsd, startedAt, completedAt }. error is set on FAILED runs."],
            ["POST", "/:id/stop", "Auth", "Halt running pipeline. Status → STOPPED."],
            ["POST", "/:id/pause", "Auth", "Suspend; resume later."],
            ["POST", "/:id/resume", "Auth", "Continue from where pause left off."],
            ["GET", "/:id/stream", "Auth", "Server-Sent Events: live step state, tool calls, costs. Closes when run terminal."],
            ["POST", "/steps/:id/rollback", "Auth", "Undo step side-effects (delete created drafts/contacts)."],
            ["POST", "/steps/:id/rerun", "Auth", "Re-execute a single step with fresh context."],
          ]} />
          <Code language="bash">{`# Trigger + tail SSE stream
curl -X POST https://braavolabs.com/api/v1/pipelines/$PIPELINE_ID/run \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
# → { id: "run_abc", jobId: "4", status: "PENDING" }

curl -N https://braavolabs.com/api/v1/runs/run_abc/stream \\
  -H "Authorization: Bearer $TOKEN"
# event: step.started   data: { stepIdx: 0, name: "Generate Content" }
# event: tool.called    data: { tool: "claude.completion", costUsd: 0.012 }
# event: step.completed data: { stepIdx: 0, costUsd: 0.012 }
# event: run.completed  data: { status: "COMPLETED", totalCostUsd: 0.012 }`}</Code>
        </Section>

        {/* === Memory === */}
        <Section id="memory-routes" title="Memory (6 endpoints)">
          <p>Memories live in the <code>candidate → approved → deprecated</code> lifecycle. Cross-company promotion requires the same pattern in 2+ companies.</p>
          <RouteList prefix="/api/v1/memory" routes={[
            ["POST", "/search", "Auth", "Body: { query, limit?, status? }. Hybrid semantic + keyword via pgvector."],
            ["POST", "/", "Auth", "Write a memory item (status defaults to candidate)."],
            ["GET", "/", "Auth", "List with filters (companyId, status, type)."],
            ["PATCH", "/:id", "Auth", "Update status (candidate→approved with validation)."],
            ["DELETE", "/:id", "Auth", "Soft-delete + mark deprecated."],
            ["POST", "/edges", "Auth", "Create graph edge between two memory items."],
          ]} />
        </Section>

        {/* === Approvals === */}
        <Section id="approvals-routes" title="Approvals (2 endpoints)">
          <p>Only spend-requiring tool calls trigger approvals. Claim race-safe via single SQL update.</p>
          <RouteList prefix="/api/v1/approvals" routes={[
            ["GET", "/", "Auth", "Filter by ?status=PENDING|APPROVED|REJECTED. Includes context (run, step, agent, cost estimate)."],
            ["POST", "/:id/decide", "Auth", "Body: { decision: 'APPROVED' | 'REJECTED', note? }. Resumes run on approve."],
          ]} />
        </Section>

        {/* === Agents === */}
        <Section id="agents-routes" title="Agents (5 endpoints — also nested under /companies/:id/agents)">
          <RouteList prefix="/api/v1/agents" routes={[
            ["GET", "/", "Auth", "List all agents across tenant companies."],
            ["GET", "/:id", "Auth", "Agent detail + version history."],
            ["GET", "/:id/versions", "Auth", "All historical prompt versions (rollback target list)."],
            ["POST", "/:id/rollback", "Auth", "Body: { versionId }. Restore an earlier prompt version."],
            ["GET", "/:id/runs", "Auth", "Recent runs that involved this agent."],
          ]} />
        </Section>

        {/* === Billing === */}
        <Section id="billing-routes" title="Billing (5 endpoints)">
          <RouteList prefix="/api/v1/billing" routes={[
            ["GET", "/usage", "Auth", "Current period usage: runs, tool calls, drafts. With plan limits."],
            ["GET", "/subscription", "Auth", "Stripe subscription state, period end, cancel-at-period-end."],
            ["POST", "/checkout", "Auth", "Body: { plan: CREATOR | PRO | BUSINESS | ENTERPRISE, billingPeriod: monthly | yearly }. Returns Stripe Checkout URL."],
            ["POST", "/portal", "Auth", "Returns Stripe customer portal URL (cancel / change card)."],
            ["POST", "/webhook", "Stripe-only", "Stripe webhook receiver. HMAC-verified. Handles all subscription lifecycle events."],
          ]} />
        </Section>

        {/* === Growth === */}
        <Section id="growth-routes" title="Growth &amp; Referral (12 endpoints)">
          <RouteList prefix="/api/v1/growth" routes={[
            ["GET", "/pql", "Auth", "Product-Qualified-Lead score for the tenant."],
            ["POST", "/referral", "Auth", "Generate a single-use referral code. Bonus runs on conversion."],
            ["GET", "/referral", "Auth", "List own codes + state."],
            ["POST", "/referral/redeem", "Auth", "Body: { code }. Apply at signup time."],
            ["POST", "/blueprint/publish", "Auth", "Publish your company spec as a public blueprint. Goes through prompt-injection scan."],
            ["GET", "/blueprint/:slug", "Public", "Public blueprint metadata."],
            ["GET", "/blueprints", "Public", "List public blueprints (paginated, filterable by primitive)."],
            ["POST", "/blueprint/:slug/clone", "Auth", "Clone someone else's blueprint into a new company."],
            ["GET", "/blueprint/mine", "Auth", "Your own blueprints (any status)."],
            ["DELETE", "/blueprint/:slug", "Auth", "Unpublish."],
            ["GET", "/leaderboard", "Public", "Top blueprints by clone count."],
            ["GET", "/stats", "Auth", "Tenant referral + blueprint stats (clones, redemptions, bonus runs)."],
          ]} />
        </Section>

        {/* === Integrations === */}
        <Section id="integrations-routes" title="Integrations (9 endpoints)">
          <RouteList prefix="/api/v1/integrations" routes={[
            ["GET", "/catalog", "Public", "200+ integration catalog: HubSpot, Slack, Notion, Linear, Discord, etc. With capability tags + status."],
            ["GET", "/", "Auth", "Connected integrations for the active company."],
            ["POST", "/", "Auth", "Connect: { type, credentials, companyId }. Credentials encrypted with AES-GCM."],
            ["PATCH", "/:id", "Auth", "Update credentials / scopes."],
            ["DELETE", "/:id", "Auth", "Disconnect (revoke OAuth token if applicable)."],
            ["POST", "/:id/test", "Auth", "Real connection test against the provider's API. Returns latency + last-fetched timestamp."],
            ["GET", "/oauth/:provider/url", "Auth", "Start OAuth flow."],
            ["GET", "/oauth/:provider/callback", "Auth", "Complete OAuth — store encrypted tokens."],
            ["POST", "/:id/refresh", "Auth", "Manually refresh OAuth access token."],
          ]} />
        </Section>

        {/* === Webhooks === */}
        <Section id="webhooks" title="Webhooks (Inbound)">
          <p>External services trigger pipelines via signed webhooks. Per-company secret. HMAC-SHA256 in <code>X-Braavolabs-Signature</code>.</p>
          <Code language="bash">{`# Example: trigger a pipeline from a 3rd-party CRM event
curl -X POST https://braavolabs.com/hooks/<company_slug>/<event_name> \\
  -H "Content-Type: application/json" \\
  -H "X-Braavolabs-Signature: sha256=<hmac-hex>" \\
  -H "X-Braavolabs-Timestamp: 1740000000" \\
  -d '{"data": "..."}'

# Signature spec
hmac = HMAC_SHA256(
  key   = company.webhookSecret,        // GET /companies/:id/webhooks
  msg   = "<timestamp>." + raw_body
)`}</Code>
          <p className="text-sm" style={{ color: "#859399" }}>
            Replay window: 5 minutes from <code>X-Braavolabs-Timestamp</code>. Outside the window = 401.
            Idempotency: events with the same <code>X-Braavolabs-Idempotency-Key</code> within
            10 minutes are deduped at the queue layer.
          </p>
        </Section>

        {/* === SSE === */}
        <Section id="sse" title="Server-Sent Events (Live Run Streaming)">
          <p>
            <code>GET /runs/:id/stream</code> opens an SSE connection. The server emits one
            event per state change until the run reaches a terminal state (COMPLETED / FAILED /
            STOPPED). Auto-reconnect via <code>Last-Event-ID</code> header is supported.
          </p>
          <Code language="javascript">{`// Browser EventSource
const es = new EventSource(
  \`/api/v1/runs/\${runId}/stream?token=\${jwt}\`  // EventSource doesn't support headers
);
es.addEventListener("step.started",   (e) => console.log("started",   JSON.parse(e.data)));
es.addEventListener("tool.called",    (e) => console.log("tool",      JSON.parse(e.data)));
es.addEventListener("step.completed", (e) => console.log("completed", JSON.parse(e.data)));
es.addEventListener("step.failed",    (e) => console.log("failed",    JSON.parse(e.data)));
es.addEventListener("run.completed",  () => es.close());
es.addEventListener("run.failed",     () => es.close());`}</Code>
        </Section>

        {/* === SDK === */}
        <Section id="sdk" title="SDK &amp; CLI">
          <p>
            No published SDK yet — the API is small enough that <code>fetch</code> covers most needs.
            Roadmap:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li><code>@braavolabs/node</code> — TypeScript SDK with typed responses (Q3 2026)</li>
            <li><code>braavolabs-cli</code> — CLI for local dev / CI integration (Q3 2026)</li>
            <li>Postman collection — live now, request via <a href="mailto:founder@braavolabs.com" style={{ color: "#a4e6ff" }}>founder@braavolabs.com</a></li>
            <li>OpenAPI schema — auto-generated, available at <code>/api/v1/openapi.json</code> (in development)</li>
          </ul>
        </Section>

        {/* === Local LLM === */}
        <Section id="local-llm" title="Self-hosted LLM — run Gemma on your own hardware (Creator+ feature)">
          <p>
            Braavolabs is one of the few autonomous-company platforms that runs end-to-end on
            a model living on <em>your</em> machine. Point us at <code>Ollama</code> or{" "}
            <code>LM Studio</code> and every prompt, every memory, every generated draft stays
            on your hardware. No prompt data leaves your laptop and there is no per-token LLM
            cost — you only pay your Braavolabs subscription.
          </p>
          <p>
            <strong>Why this matters:</strong> KVKK / GDPR-sensitive workloads (legal, healthcare,
            HR, regulated finance), agencies that need to demo without exposing client data, teams
            iterating heavily who don&apos;t want a per-token cloud bill on top of their plan, and
            anyone who wants their company to keep working when the office Wi-Fi drops.
          </p>
          <p>
            <strong>Plan requirement:</strong> self-hosted providers are unlocked on{" "}
            <a href="/pricing" style={{ color: "#a4e6ff" }}>Creator ($19/mo) and above</a>. The
            FREE plan supports cloud BYOK only (Anthropic / OpenAI / Google etc.).
          </p>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Setup — Ollama (recommended, 3 minutes)
          </h3>
          <Code language="bash">{`# 1. Install Ollama (macOS / Linux / Windows)
#    https://ollama.com/download

# 2. Pull Gemma 3 — 4B fits in 8GB RAM, 12B wants 16GB, 27B wants 32GB
ollama pull gemma3:4b

# 3. Start the server (leave it running in a terminal tab)
ollama serve
# → listens on http://localhost:11434

# 4. Verify Gemma is reachable
curl http://localhost:11434/v1/models
# → { "data": [{ "id": "gemma3:4b", ... }] }`}</Code>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Setup — LM Studio (GUI alternative)
          </h3>
          <Code language="bash">{`# 1. Install LM Studio: https://lmstudio.ai
# 2. Search the model browser for "google/gemma-3-4b-it" → Download
# 3. Open the "Local Server" tab → click "Start Server"
#    → exposes an OpenAI-compatible API on http://localhost:1234

# That's it — no terminal commands required.`}</Code>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Wire it up in Braavolabs
          </h3>
          <ol className="list-decimal pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li>Go to <a href="/settings" style={{ color: "#a4e6ff" }}>Settings → AI Provider</a></li>
            <li>Pick <strong>Ollama (local Gemma · FREE)</strong> or <strong>LM Studio (local · FREE)</strong></li>
            <li>Choose a model from the dropdown — <code>gemma3:4b</code> is the safe default</li>
            <li>The Base URL is pre-filled (<code>http://localhost:11434/v1</code> for Ollama)</li>
            <li>Leave the API key blank — local providers don&apos;t need one</li>
            <li>Click <strong>Save</strong>, then <strong>Test Connection</strong> → expect <code>OK</code></li>
          </ol>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Choosing a model (quick reference)
          </h3>
          <Table headers={["Model", "RAM needed", "Speed", "Best for"]}>
            <Row>gemma3:4b<EOR />8 GB<EOR />Fast (30-60 tok/s on M-series)<EOR />Daily content, outreach, summarisation</Row>
            <Row>gemma3:12b<EOR />16 GB<EOR />Medium<EOR />Reasoning, longer drafts, planner</Row>
            <Row>gemma3:27b<EOR />32 GB<EOR />Slow<EOR />Heavy strategy / multi-step pipelines</Row>
            <Row>llama3.3:70b (Q4_K_M)<EOR />48+ GB<EOR />Slow<EOR />Comparable to GPT-4o on reasoning</Row>
            <Row>qwen2.5-coder:14b<EOR />16 GB<EOR />Medium<EOR />Code generation / SDK scaffolding</Row>
          </Table>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            What stays local, what doesn&apos;t
          </h3>
          <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li><strong>Local on your machine:</strong> every prompt, every model response, every generated draft, every reasoning trace.</li>
            <li><strong>Still on Braavolabs servers (encrypted):</strong> account metadata (email, plan), audit logs, tool-call records, run timing, billing usage counters. <em>Never</em> the prompt content.</li>
            <li><strong>External integrations only fire if you wire them:</strong> HubSpot, Stripe, SendGrid, social posters etc. — Braavolabs proxies those on your behalf when a tool is invoked.</li>
          </ul>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Custom OpenAI-compatible endpoints
          </h3>
          <p>
            Pick the <strong>Custom</strong> provider for any OpenAI-shaped{" "}
            <code>/v1/chat/completions</code> server — vLLM, LiteLLM proxies, Together,
            RunPod, Fireworks, Anyscale, Cloudflare Workers AI, self-hosted text-generation-webui,
            etc. Provide a Base URL and (if the endpoint requires it) an API key.
          </p>
          <Code language="bash">{`# Example: route all Braavolabs traffic through a self-hosted LiteLLM proxy
#   Settings → AI Provider → Custom
#   Base URL: https://litellm.your-domain.com/v1
#   Model:    azure/gpt-4o   (or whatever LiteLLM exposes)
#   API Key:  <your LiteLLM master key>`}</Code>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Troubleshooting
          </h3>
          <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li><strong>&ldquo;Connection refused&rdquo;</strong> — Ollama or LM Studio isn&apos;t running. Open a terminal and run <code>ollama serve</code>, or click &ldquo;Start Server&rdquo; in LM Studio.</li>
            <li><strong>&ldquo;model not found&rdquo;</strong> — pull it first: <code>ollama pull gemma3:4b</code>. The model name in Settings must match what <code>ollama list</code> shows exactly.</li>
            <li><strong>Slow first response</strong> — the model is being loaded into RAM. Subsequent requests are 10× faster.</li>
            <li><strong>Test from server (production deploy)</strong> — production Braavolabs runs on Lightsail and cannot reach <code>localhost:11434</code> on your laptop. Local LLM is a <em>self-hosted</em> feature: clone the repo and run <code>pnpm dev</code> alongside Ollama for the fully-private setup.</li>
          </ul>
        </Section>

        {/* === Skills Library === */}
        <Section id="skills-library" title="Skills Library — 1,700+ curated agents from The Repo God">
          <p>
            Beyond our 50+ Blueprint Marketplace templates, Braavolabs maintains{" "}
            <strong>The Repo God</strong> — a curated library of <strong>1,700+ agents,
            skills, hooks, and workflow patterns</strong> distilled from 56 upstream
            repositories (Anthropic Skills, agency-agents, claude-mem, serena, ccpm,
            flutter-skills, supabase-skills, trailofbits-skills, last30days-skill,
            cartographer, and many more).
          </p>
          <p>
            <strong>Current status:</strong> 10 of these patterns ship as production-ready
            Blueprint templates today (#43-52 in <a href="/marketplace" style={{ color: "#a4e6ff" }}>Marketplace</a>) — the rest are
            available as a read-only browseable catalog you can request access to. We
            don&apos;t auto-execute third-party skill code in production: each addition
            goes through a permission manifest + sandbox review. This page is a roadmap of
            what&apos;s coming.
          </p>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            Already shipped as Blueprints (10)
          </h3>
          <Table headers={["Blueprint", "Source repo", "Local-friendly"]}>
            <Row>Persistent Memory Brain<EOR />claude-mem<EOR />✓ Gemma 3 4B</Row>
            <Row>Codebase Cartographer<EOR />cartographer + serena + understand-anything<EOR />Gemma 12B+</Row>
            <Row>Spec-Driven Project Manager<EOR />ccpm + get-shit-done<EOR />Cloud</Row>
            <Row>Real-Time Research Agent<EOR />last30days-skill<EOR />✓ Gemma 3 4B</Row>
            <Row>Reddit Video Producer<EOR />reddit-video-maker<EOR />✓ Gemma 3 4B</Row>
            <Row>Mobile QA Agency<EOR />flutter-test-skill + appium-mcp<EOR />Cloud</Row>
            <Row>Knowledge Vault Manager<EOR />arscontexta + claudian<EOR />✓ Gemma 3 4B</Row>
            <Row>Compliance Auditor (KVKK/GDPR/SOC2)<EOR />trailofbits-skills<EOR />Cloud</Row>
            <Row>SaaS Integration Hub<EOR />awesome-claude-skills<EOR />✓ Gemma 3 4B</Row>
            <Row>Multi-Agent Engineering Team<EOR />everything-claude-code + agency-agents<EOR />Cloud</Row>
          </Table>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            What&apos;s in the larger library (preview)
          </h3>
          <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li><strong>Engineering &amp; DevTools</strong> — 176 agents (agency-agents), 28 agents + 125 skills + 60 commands (everything-claude-code), 32 agents + 32 skills (oh-my-claudecode), 11 agents + 41 commands (claude-forge), 127+ subagents (awesome-subagents), 112 agents + 147 skills (wshobson-agents)</li>
            <li><strong>Project Management</strong> — PRD→Epic→GitHub Issue→Parallel exec (ccpm), 20+ commands + 10 agents (get-shit-done), persistent planning patterns (planning-with-files), graph-based task memory (beads · Dolt DB)</li>
            <li><strong>Memory &amp; Context</strong> — 5 skills + cross-session continuity (claude-mem), context rot prevention (continuous-claude-v3), three-space second-brain pipeline (arscontexta)</li>
            <li><strong>Mobile &amp; Cross-Platform</strong> — 22 Flutter skills (flutter-skills), 28 skills + 26 rules (flutter-ai-rules), 253 MCP tools (flutter-test-skill), 10 React Native skills + 6 agents + 38 rules (reactnative-agent-skills)</li>
            <li><strong>Backend &amp; Database</strong> — 8 Postgres categories (supabase-agent-skills), schema design + RLS (pg-aiguide), 5 service skills (supabase-skills)</li>
            <li><strong>Security &amp; Compliance</strong> — 30 skills covering smart contract audit, malware analysis, reverse engineering (trailofbits-skills), 14 git + 5 rm destructive-command blockers (claude-code-safety-net)</li>
            <li><strong>Marketing &amp; Growth</strong> — 34 skills covering CRO, SEO, pricing, analytics (marketingskills), 78+ Composio integrations across 500+ apps (awesome-claude-skills)</li>
            <li><strong>Research &amp; Analysis</strong> — Reddit/X/YouTube/HN/web scan + synthesis (last30days-skill), 52 LSP semantic code analysis (serena), parallel-subagent codebase mapping (cartographer)</li>
            <li><strong>Observability</strong> — Real-time session dashboard (claude-hud), Vue+WebSocket timeline (multi-agent-observability), OpenTelemetry+Prometheus+Grafana (claude-code-otel)</li>
            <li><strong>Productivity Integrations</strong> — Asana, Atlassian, ClickUp, Linear, Monday, MS365, Notion, Slack, Gmail, Calendar (Anthropic plugin set)</li>
          </ul>

          <h3 className="font-semibold mt-6 mb-2" style={{ color: "#e1e2eb" }}>
            How to request more skills
          </h3>
          <ol className="list-decimal pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li>Email <a href="mailto:founder@braavolabs.com?subject=Skills%20Library%20request" style={{ color: "#a4e6ff" }}>founder@braavolabs.com</a> with your use case.</li>
            <li>We&apos;ll point you at the upstream repo + give you the Blueprint template if one exists.</li>
            <li>If you&apos;re on Business+ and need a custom skill ported into Braavolabs, we&apos;ll do the permission-manifest + sandbox review (typical SLA: 5 business days).</li>
          </ol>

          <p className="mt-6 text-xs" style={{ color: "#5a6770" }}>
            Why we don&apos;t auto-import all 1,700: each upstream agent has different
            execution semantics (Claude Code skill, Anthropic Agent SDK, n8n workflow,
            raw shell hook). Auto-running unverified third-party code in a multi-tenant
            production environment is a security non-starter. The 10 we&apos;ve shipped
            went through hand-port + prompt-engineering + governance review. The rest
            stay browseable until they earn the same treatment.
          </p>
        </Section>

        {/* === Security === */}
        <Section id="security" title="Security">
          <ul className="list-disc pl-5 space-y-1 text-sm" style={{ color: "#bbc9cf" }}>
            <li>AES-256-GCM at-rest encryption for OAuth tokens, API keys, webhook secrets (scrypt-derived per-tenant key)</li>
            <li>TLS 1.3 in transit (Cloudflare edge → origin)</li>
            <li>JWT alg pinned to HS256 at verify time</li>
            <li>Bcrypt cost-12 for password hashes</li>
            <li>Account lockout after 5 failed logins (Redis-backed, IP-aware)</li>
            <li>Login + forgot-password are timing-attack-resistant (constant-time bcrypt + async SendGrid)</li>
            <li>Disposable email block list at signup</li>
            <li>Multi-tenant boundary: every Prisma query scoped by tenantId middleware</li>
            <li>Webhook signatures: HMAC-SHA256 with <code>timingSafeEqual</code>, 5-min replay window</li>
            <li>Reports security issues: <a href="mailto:security@braavolabs.com" style={{ color: "#a4e6ff" }}>security@braavolabs.com</a> — PGP key on request</li>
          </ul>
        </Section>

        {/* === Changelog === */}
        <Section id="changelog" title="Changelog">
          <Table headers={["Date", "Change"]}>
            <Row>2026-04-29<EOR />Self-hosted LLM support (Creator+) — Ollama / LM Studio / Custom OpenAI-compatible. Gemma 3 4B as the privacy-first default. New <code>baseUrl</code> field on UserAIConfig + tenant-scoped overrides. Plan-enum gate aligned with schema (CREATOR/PRO/BUSINESS/ENTERPRISE).</Row>
            <Row>2026-04-28<EOR />Run.error now propagates from failed step (was null). 5-tier plan sync. Onboarding state persisted.</Row>
            <Row>2026-04-27<EOR />Login + forgot-password timing oracle hardening. Refresh token jti rotation. CSP frame-ancestors.</Row>
            <Row>2026-04-26<EOR />Production launch. KVKK/GDPR cookie banner. Branded welcome + reset emails. S3 backup + restore drill.</Row>
          </Table>
        </Section>

        <div
          className="mt-14 p-6 rounded-2xl text-center"
          style={{ background: "rgba(0,209,255,0.05)", border: "1px solid rgba(0,209,255,0.15)" }}
        >
          <p className="font-semibold mb-2">Questions about the API?</p>
          <p className="text-sm mb-4" style={{ color: "#859399" }}>
            Reply guarantee under 24h.
          </p>
          <a
            href="mailto:founder@braavolabs.com?subject=API%20documentation%20question"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            Email the founder
          </a>
        </div>
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — kept inline so this file is self-contained.
// ────────────────────────────────────────────────────────────────────────────

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-12 scroll-mt-20">
      <h2
        className="font-headline font-bold text-lg mb-4"
        style={{ color: "#00d1ff", borderBottom: "1px solid rgba(0,209,255,0.1)", paddingBottom: "0.5rem" }}
      >
        {title}
      </h2>
      <div className="space-y-4 text-sm" style={{ color: "#bbc9cf", lineHeight: 1.65 }}>
        {children}
      </div>
    </section>
  );
}

function Code({ children, language }: { children: string; language: string }) {
  return (
    <pre
      className="p-4 rounded-lg overflow-x-auto text-xs"
      style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.06)", color: "#bbc9cf", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
      data-lang={language}
    >
      <code>{children}</code>
    </pre>
  );
}

type RouteRow = [method: string, path: string, auth: string, desc: string];
function RouteList({ prefix, routes }: { prefix: string; routes: RouteRow[] }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <table className="w-full text-xs">
        <thead style={{ background: "rgba(255,255,255,0.03)" }}>
          <tr>
            <th className="text-left px-3 py-2 font-semibold" style={{ color: "#859399" }}>Method</th>
            <th className="text-left px-3 py-2 font-semibold" style={{ color: "#859399" }}>Path</th>
            <th className="text-left px-3 py-2 font-semibold" style={{ color: "#859399" }}>Auth</th>
            <th className="text-left px-3 py-2 font-semibold" style={{ color: "#859399" }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {routes.map(([m, p, a, d]) => (
            <tr key={`${m}-${p}`} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <td className="px-3 py-2 align-top whitespace-nowrap">
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-bold"
                  style={{
                    color: m === "GET" ? "#34d399" : m === "POST" ? "#00d1ff" : m === "PATCH" ? "#facc15" : m === "DELETE" ? "#fb7185" : "#bbc9cf",
                    background: m === "GET" ? "rgba(52,211,153,0.1)" : m === "POST" ? "rgba(0,209,255,0.1)" : m === "PATCH" ? "rgba(250,204,21,0.1)" : m === "DELETE" ? "rgba(251,113,133,0.1)" : "rgba(255,255,255,0.06)",
                  }}
                >
                  {m}
                </span>
              </td>
              <td className="px-3 py-2 align-top whitespace-nowrap font-mono" style={{ color: "#e1e2eb" }}>
                {prefix}
                <span style={{ color: "#a4e6ff" }}>{p}</span>
              </td>
              <td className="px-3 py-2 align-top whitespace-nowrap" style={{ color: "#859399" }}>{a}</td>
              <td className="px-3 py-2 align-top" style={{ color: "#bbc9cf" }}>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <table className="w-full text-xs">
        <thead style={{ background: "rgba(255,255,255,0.03)" }}>
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left px-3 py-2 font-semibold" style={{ color: "#859399" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Row + EOR (end-of-row column splitter) — keep table cells declarative.
function Row({ children }: { children: React.ReactNode }) {
  // Convert children into <td> cells split by <EOR /> markers.
  const arr = Array.isArray(children) ? children : [children];
  const cells: React.ReactNode[][] = [[]];
  for (const child of arr) {
    if (
      typeof child === "object" &&
      child !== null &&
      // @ts-ignore — element check
      child.type === EOR
    ) {
      cells.push([]);
    } else {
      cells[cells.length - 1].push(child);
    }
  }
  return (
    <tr style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
      {cells.map((c, i) => (
        <td key={i} className="px-3 py-2 align-top" style={{ color: "#bbc9cf" }}>
          {c}
        </td>
      ))}
    </tr>
  );
}
function EOR() {
  return null;
}
