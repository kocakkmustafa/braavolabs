import { pathToFileURL } from "node:url";

// Display names and useful steps are deliberately explicit: setup-only green
// jobs, skipped work and an old workflow revision cannot authorize publication.
export const REQUIRED_JOBS = Object.freeze({
  "Lint & Type Check": ["Type check API", "Lint"],
  Test: ["Run tests (only packages that define a test script)"],
  Build: ["Build workspaces"],
  "Docker Build": ["Build Docker image", "Test Docker image starts"],
  "Boot Smoke": ["Build api image (cached)", "Boot api container + wait for /api/v1/health (from inside)"],
  "DB Migration Check": ["Run migrations", "Validate schema"],
  "E2E (Playwright)": ["Cross-tenant isolation matrix", "Run E2E"],
  "SBOM + checksums": ["Generate and verify release artifacts"],
  "Release contracts + brand motion": ["Release contract regressions", "Brand motion regressions"],
  "Post-merge workflow watchdog": ["Verify required sibling jobs"],
});
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const MAX_TIMEOUT_MS = 25 * 60 * 1000;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
function requireEvidence(condition, message) {
  if (!condition) throw new Error(`CI gate: ${message}`);
}
function successfulWork(value) {
  return value?.status === "completed" && value.conclusion === "success"
    && validTime(value.started_at) && validTime(value.completed_at)
    && Date.parse(value.completed_at) >= Date.parse(value.started_at);
}

/** Read-only, dependency-injected and bounded. Never call from the CI run itself. */
export async function requireGreenCi({
  repository, sha, token, fetchImpl = globalThis.fetch,
  now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = MAX_TIMEOUT_MS, pollIntervalMs = 15_000, requestTimeoutMs = 10_000,
}) {
  requireEvidence(typeof repository === "string" && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && !repository.endsWith("/.") && !repository.endsWith("/.."), "invalid repository");
  requireEvidence(typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha), "exact commit SHA required");
  requireEvidence(typeof token === "string" && token.trim().length > 0, "GitHub read token required");
  requireEvidence(positiveInteger(timeoutMs) && timeoutMs <= MAX_TIMEOUT_MS
    && positiveInteger(pollIntervalMs) && pollIntervalMs <= 30_000
    && positiveInteger(requestTimeoutMs) && requestTimeoutMs <= 10_000, "invalid time bounds");
  const deadline = now() + timeoutMs;
  const base = `/repos/${repository}`;
  const sameRepository = (value) => typeof value === "string" && value.toLowerCase() === repository.toLowerCase();
  function remaining() {
    const ms = deadline - now();
    requireEvidence(ms > 0, "timed out waiting for exact main-push CI");
    return ms;
  }
  async function get(path) {
    const controller = new AbortController();
    let timer;
    const duration = Math.min(requestTimeoutMs, remaining());
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`https://api.github.com${path}`, {
            method: "GET", redirect: "error", signal: controller.signal,
            headers: {
              Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "braavolabs-exact-ci-gate",
              "Cache-Control": "no-cache",
            },
          });
          if (!response.ok || response.status !== 200) throw new Error("HTTP failure");
          return await response.json();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, duration);
        }),
      ]);
    } catch {
      // No upstream response, token, request headers or transport exception is
      // echoed. Authentication, rate-limit and transport errors all fail closed.
      throw new Error("CI gate: GitHub read request failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async function list(path, key) {
    const rows = [];
    let total;
    // GitHub caps filtered workflow-run searches at 1,000. Refuse incomplete
    // evidence; never choose the first page's success when later pages differ.
    for (let page = 1; page <= 10; page++) {
      const result = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      requireEvidence(Number.isSafeInteger(result?.total_count) && result.total_count >= 0
        && result.total_count <= 1000 && Array.isArray(result[key]), "invalid or excessive pagination");
      if (total === undefined) total = result.total_count;
      requireEvidence(total === result.total_count, "pagination changed during read");
      const expected = Math.min(100, total - rows.length);
      requireEvidence(result[key].length === expected, "incomplete pagination");
      rows.push(...result[key]);
      if (rows.length === total) return rows;
    }
    throw new Error("CI gate: pagination limit exceeded");
  }
  const workflow = await get(`${base}/actions/workflows/ci.yml`);
  requireEvidence(positiveInteger(workflow?.id) && workflow.name === "CI"
    && workflow.path === WORKFLOW_PATH && workflow.state === "active", "wrong or disabled CI workflow");

  const seenAttempts = new Map();
  let newestSeenRunId = 0;
  function validateRun(run) {
    requireEvidence(positiveInteger(run?.id) && positiveInteger(run.run_attempt)
      && run.workflow_id === workflow.id && run.name === "CI" && run.path === WORKFLOW_PATH
      && run.head_sha === sha && run.head_branch === "main" && run.event === "push"
      && sameRepository(run.repository?.full_name) && sameRepository(run.head_repository?.full_name)
      && validTime(run.created_at) && validTime(run.updated_at)
      && Date.parse(run.updated_at) >= Date.parse(run.created_at), "run identity/version mismatch");
    requireEvidence(run.run_attempt >= (seenAttempts.get(run.id) ?? 0), "CI attempt evidence regressed");
    seenAttempts.set(run.id, run.run_attempt);
  }
  async function latestRun() {
    const runs = await list(`${base}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&branch=main&event=push`, "workflow_runs");
    const identities = new Set();
    for (const run of runs) {
      validateRun(run);
      requireEvidence(!identities.has(run.id), "duplicate run evidence");
      identities.add(run.id);
    }
    const newest = runs.sort((a, b) => b.id - a.id)[0];
    requireEvidence((newest?.id ?? 0) >= newestSeenRunId, "latest CI run evidence regressed");
    if (!newest) return undefined;
    newestSeenRunId = newest.id;
    // Completion time is not creation order: an older first run can finish
    // after a newer failure. Conversely, a fresh retry of an older run id must
    // not be hidden by the newer id's stale success. Conflicting retry order
    // is ambiguous: refuse it, then require a full rerun of the newest run.
    const newestBoundary = newest.run_attempt > 1 ? newest.updated_at : newest.created_at;
    requireEvidence(!runs.some((run) => run.id !== newest.id && run.run_attempt > 1
      && Date.parse(run.updated_at) >= Date.parse(newestBoundary)), "ambiguous newer retry of an older CI run");
    return newest;
  }
  function validateJobs(jobs, run) {
    requireEvidence(jobs.length === Object.keys(REQUIRED_JOBS).length, "missing or unexpected required jobs");
    const ids = new Set();
    for (const [name, requiredSteps] of Object.entries(REQUIRED_JOBS)) {
      const matches = jobs.filter((job) => job.name === name);
      requireEvidence(matches.length === 1, "missing or duplicate required job");
      const job = matches[0];
      requireEvidence(positiveInteger(job.id) && !ids.has(job.id) && positiveInteger(job.runner_id)
        && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === sha
        && successfulWork(job) && Array.isArray(job.steps) && job.steps.length > 0, "required job did not usefully succeed");
      ids.add(job.id);
      for (const stepName of requiredSteps) {
        const steps = job.steps.filter((step) => step.name === stepName);
        requireEvidence(steps.length === 1 && positiveInteger(steps[0].number)
          && successfulWork(steps[0]), "required step did not usefully succeed");
      }
    }
  }
  async function pause() { await sleep(Math.min(pollIntervalMs, remaining())); }
  while (true) {
    remaining();
    const selected = await latestRun();
    if (!selected) { await pause(); continue; }
    const current = await get(`${base}/actions/runs/${selected.id}`);
    validateRun(current);
    requireEvidence(current.id === selected.id && current.run_attempt >= selected.run_attempt, "run readback regressed");
    if (current.status !== "completed") {
      requireEvidence(["queued", "in_progress", "waiting", "pending", "requested"].includes(current.status), "unknown CI status");
      await pause();
      continue;
    }
    requireEvidence(current.conclusion === "success", "latest CI did not succeed");
    const jobs = await list(`${base}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs`, "jobs");
    validateJobs(jobs, current);
    const readback = await get(`${base}/actions/runs/${current.id}`);
    validateRun(readback);
    requireEvidence(readback.id === current.id && readback.run_attempt === current.run_attempt
      && readback.status === "completed" && readback.conclusion === "success", "CI changed during job verification");
    const latest = await latestRun();
    requireEvidence(latest?.id === current.id && latest.run_attempt === current.run_attempt
      && latest.status === "completed" && latest.conclusion === "success", "latest CI changed during verification");
    remaining();
    return { runId: current.id, attempt: current.run_attempt, sha, jobCount: jobs.length };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await requireGreenCi({ repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA, token: process.env.GITHUB_TOKEN });
    console.log(`CI gate verified: run ${result.runId}, attempt ${result.attempt}, SHA ${result.sha}, ${result.jobCount} useful jobs.`);
  } catch (error) {
    // All gate errors above use fixed local messages, never API payloads.
    console.error(error.message);
    process.exitCode = 1;
  }
}
