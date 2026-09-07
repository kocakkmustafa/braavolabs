import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requireGreenCi, REQUIRED_JOBS } from "./require-green-ci.mjs";

const repository = "owner/product";
const sha = "a".repeat(40);
const timestamp = "2026-09-07T12:00:00Z";
const workflow = { id: 17, name: "CI", path: ".github/workflows/ci.yml", state: "active" };
const run = {
  id: 101, run_attempt: 1, workflow_id: 17, name: "CI", path: workflow.path,
  head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  repository: { full_name: repository }, head_repository: { full_name: repository },
  created_at: timestamp, updated_at: timestamp,
};
const jobSteps = {
  "Lint & Type Check": ["Type check API"],
  Test: ["Run tests (only packages that define a test script)"],
  Build: ["Build workspaces"],
  "Docker Build": ["Build Docker image", "Test Docker image starts"],
  "Boot Smoke": ["Build api image (cached)", "Boot api container + wait for /api/v1/health (from inside)"],
  "DB Migration Check": ["Run migrations", "Validate schema"],
  "E2E (Playwright)": ["Cross-tenant isolation matrix", "Run E2E"],
  "SBOM + checksums": ["Generate and verify release artifacts"],
  "Release contracts + brand motion": ["Release contract regressions", "Brand motion regressions"],
  "Post-merge workflow watchdog": ["Verify required sibling jobs"],
};
function makeJobs(attempt = 1) {
  return Object.entries(jobSteps).map(([name, names], index) => ({
    id: index + 201, name, run_id: run.id, run_attempt: attempt, head_sha: sha,
    status: "completed", conclusion: "success", runner_id: 301,
    started_at: timestamp, completed_at: timestamp,
    steps: names.map((name, i) => ({
      name, number: i + 1, status: "completed", conclusion: "success",
      started_at: timestamp, completed_at: timestamp,
    })),
  }));
}

function fixture({ runs = [run], jobs = makeJobs(), detail, respond } = {}) {
  const calls = [];
  let elapsed = 0;
  let listCalls = 0;
  let detailCalls = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const override = respond?.(url, init, calls.length);
    if (override) return override;
    let data;
    if (url.pathname.endsWith("/workflows/ci.yml")) data = workflow;
    else if (url.pathname.endsWith("/workflows/17/runs")) {
      listCalls++;
      const current = typeof runs === "function" ? runs(listCalls) : runs;
      data = { total_count: current.length, workflow_runs: current };
    } else if (/\/attempts\/\d+\/jobs$/.test(url.pathname)) {
      data = { total_count: jobs.length, jobs };
    } else if (/\/runs\/\d+$/.test(url.pathname)) {
      detailCalls++;
      data = typeof detail === "function" ? detail(detailCalls) : detail ?? run;
    } else assert.fail(`Unexpected endpoint: ${url.pathname}`);
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  };
  return {
    calls,
    options: {
      repository, sha, token: "fixture-token", fetchImpl,
      now: () => elapsed, sleep: async (ms) => { elapsed += ms; },
      timeoutMs: 30, pollIntervalMs: 10,
    },
  };
}

test("accepts exact completed main-push CI only after attempt-specific jobs and final readback", async () => {
  assert.deepEqual(REQUIRED_JOBS, jobSteps);
  const f = fixture();
  assert.deepEqual(await requireGreenCi(f.options), { runId: 101, attempt: 1, sha, jobCount: 10 });
  assert.ok(f.calls.some(({ url }) => url.pathname.endsWith("/runs/101/attempts/1/jobs")));
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/runs/101")).length, 2);
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/workflows/17/runs")).length, 2);
  for (const { url, init } of f.calls) {
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    if (url.pathname.endsWith("/workflows/17/runs")) {
      assert.equal(url.searchParams.get("head_sha"), sha);
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("event"), "push");
      assert.equal(url.searchParams.has("status"), false, "success filtering hides newer failures");
    }
  }
});

for (const [label, patch] of Object.entries({
  "wrong SHA": { head_sha: "b".repeat(40) },
  "PR event": { event: "pull_request" },
  "manual CI": { event: "workflow_dispatch" },
  "non-main branch": { head_branch: "feature" },
  "wrong workflow id": { workflow_id: 18 },
  "wrong workflow path": { path: ".github/workflows/other.yml" },
  "wrong workflow name": { name: "CI spoof" },
  "wrong repository": { repository: { full_name: "other/product" } },
  "fork head": { head_repository: { full_name: "fork/product" } },
  "missing attempt": { run_attempt: undefined },
  "missing run id": { id: undefined },
  "missing ordering evidence": { updated_at: undefined },
})) test(`rejects ${label} even with a success label`, async () => {
  const bad = { ...run, ...patch };
  await assert.rejects(requireGreenCi(fixture({ runs: [bad], detail: bad }).options));
});

for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", null]) {
  test(`rejects completed conclusion ${conclusion}`, async () => {
    const bad = { ...run, conclusion };
    await assert.rejects(requireGreenCi(fixture({ runs: [bad], detail: bad }).options));
  });
}

for (const status of ["queued", "in_progress", "waiting", "pending"]) {
  test(`bounded timeout for ${status}, never substitutes older successful run`, async () => {
    const pending = { ...run, status, conclusion: null };
    const f = fixture({ runs: [pending], detail: pending });
    await assert.rejects(requireGreenCi(f.options), /timed out/i);
    assert.ok(f.calls.length < 15);
    assert.equal(f.calls.some(({ url }) => url.pathname.endsWith("/jobs")), false);
  });
}

test("missing run waits boundedly; queued run can become a genuine success", async () => {
  await assert.rejects(requireGreenCi(fixture({ runs: [] }).options), /timed out/i);
  const pending = { ...run, status: "queued", conclusion: null };
  const f = fixture({ runs: (n) => n === 1 ? [] : [run], detail: (n) => n === 1 ? pending : run });
  assert.equal((await requireGreenCi(f.options)).runId, 101);
});

test("newer failed run wins over older green, even when API rows arrive unsorted", async () => {
  const failed = { ...run, id: 102, conclusion: "failure", updated_at: "2026-09-07T12:01:00Z" };
  const f = fixture({ runs: [run, failed], detail: failed });
  await assert.rejects(requireGreenCi(f.options));
  assert.ok(f.calls.some(({ url }) => url.pathname.endsWith("/runs/102")));
});

test("fresh failed rerun of an older run cannot be hidden by a higher-id old success", async () => {
  const failed = { ...run, id: 100, run_attempt: 2, conclusion: "failure", updated_at: "2026-09-07T12:01:00Z" };
  await assert.rejects(requireGreenCi(fixture({ runs: [run, failed], detail: failed }).options));
});

test("late completion of an older first run cannot hide a newer failed run", async () => {
  const old = { ...run, updated_at: "2026-09-07T12:10:00Z" };
  const failed = { ...run, id: 102, conclusion: "failure", created_at: "2026-09-07T12:01:00Z", updated_at: "2026-09-07T12:02:00Z" };
  const f = fixture({ runs: [old, failed], detail: old,
    respond: (url) => url.pathname.endsWith("/runs/102") && ({ ok: true, status: 200, json: async () => failed }),
  });
  await assert.rejects(requireGreenCi(f.options));
  assert.ok(f.calls.some(({ url }) => url.pathname.endsWith("/runs/102")));
});

test("successful rerun requires all useful jobs from the current attempt", async () => {
  const second = { ...run, run_attempt: 2 };
  const f = fixture({ runs: [second], detail: second, jobs: makeJobs(2) });
  assert.equal((await requireGreenCi(f.options)).attempt, 2);
  await assert.rejects(requireGreenCi(fixture({ runs: [second], detail: second, jobs: makeJobs(1) }).options));
});

test("final run/list readbacks catch a newly queued or failed retry and a newer run", async () => {
  const failed = { ...run, run_attempt: 2, conclusion: "failure" };
  await assert.rejects(requireGreenCi(fixture({ detail: (n) => n === 1 ? run : failed }).options));
  const queued = { ...run, run_attempt: 2, status: "queued", conclusion: null };
  await assert.rejects(requireGreenCi(fixture({ detail: (n) => n === 1 ? run : queued }).options));
  const newer = { ...run, id: 102, conclusion: "failure", updated_at: "2026-09-07T12:01:00Z" };
  await assert.rejects(requireGreenCi(fixture({ runs: (n) => n === 1 ? [run] : [run, newer] }).options));
});

test("polling cannot regress from a queued new attempt or new run to an older success", async () => {
  const queuedAttempt = { ...run, run_attempt: 2, status: "queued", conclusion: null };
  await assert.rejects(requireGreenCi(fixture({
    runs: (n) => n === 1 ? [queuedAttempt] : [run],
    detail: (n) => n === 1 ? queuedAttempt : run,
  }).options));
  const queuedRun = { ...run, id: 102, status: "queued", conclusion: null };
  await assert.rejects(requireGreenCi(fixture({
    runs: (n) => n === 1 ? [queuedRun] : [run],
    detail: (n) => n === 1 ? queuedRun : run,
  }).options));
});

test("wrong/disabled workflow metadata and unknown states cannot authorize deployment", async () => {
  for (const patch of [{ id: 0 }, { path: ".github/workflows/deploy.yml" }, { name: "other" }, { state: "disabled_manually" }]) {
    const f = fixture({ respond: (url) => url.pathname.endsWith("/workflows/ci.yml") && ({
      ok: true, status: 200, json: async () => ({ ...workflow, ...patch }),
    }) });
    await assert.rejects(requireGreenCi(f.options));
  }
  const unknown = { ...run, status: "unknown" };
  await assert.rejects(requireGreenCi(fixture({ runs: [unknown], detail: unknown }).options));
});

for (const [label, change] of Object.entries({
  "zero jobs": () => [],
  "missing required job": (jobs) => jobs.slice(1),
  "duplicate required job": (jobs) => [...jobs, { ...jobs[0], id: 999 }],
  "failed job": (jobs) => { jobs[0].conclusion = "failure"; return jobs; },
  "skipped job": (jobs) => { jobs[0].conclusion = "skipped"; return jobs; },
  "runner zero": (jobs) => { jobs[0].runner_id = 0; return jobs; },
  "zero steps": (jobs) => { jobs[0].steps = []; return jobs; },
  "setup-only steps": (jobs) => { jobs[0].steps[0].name = "Set up job"; return jobs; },
  "failed required step": (jobs) => { jobs[0].steps[0].conclusion = "failure"; return jobs; },
  "skipped required step": (jobs) => { jobs[0].steps[0].conclusion = "skipped"; return jobs; },
  "step never started": (jobs) => { jobs[0].steps[0].started_at = null; return jobs; },
  "job never finished": (jobs) => { jobs[0].completed_at = null; return jobs; },
  "wrong job SHA": (jobs) => { jobs[0].head_sha = "b".repeat(40); return jobs; },
  "wrong job run": (jobs) => { jobs[0].run_id = 999; return jobs; },
})) test(`rejects ${label}`, async () => {
  await assert.rejects(requireGreenCi(fixture({ jobs: change(makeJobs()) }).options));
});

test("API status, network, JSON and partial pagination failures stay fail-closed and redact upstream text", async () => {
  for (const respond of [
    () => ({ ok: false, status: 403, json: async () => ({ message: "SECRET" }) }),
    () => { throw new Error("SECRET network"); },
    () => ({ ok: true, status: 200, json: async () => { throw new Error("SECRET JSON"); } }),
    (url) => url.pathname.endsWith("/jobs") && ({ ok: true, status: 200, json: async () => ({ total_count: 11, jobs: makeJobs() }) }),
    (url) => url.pathname.endsWith("/workflows/17/runs") && ({ ok: true, status: 200, json: async () => ({ total_count: 2, workflow_runs: [run] }) }),
  ]) {
    await assert.rejects(requireGreenCi(fixture({ respond }).options), (error) => !error.message.includes("SECRET"));
  }
});

test("pagination cannot conceal a failure on page two", async () => {
  const extras = Array.from({ length: 100 }, (_, i) => ({ ...run, id: 1000 + i }));
  const newer = { ...run, id: 9999, conclusion: "failure", updated_at: "2026-09-07T12:01:00Z" };
  const f = fixture({ detail: newer, respond: (url) => url.pathname.endsWith("/workflows/17/runs") && ({
    ok: true, status: 200,
    json: async () => ({ total_count: 101, workflow_runs: url.searchParams.get("page") === "2" ? [newer] : extras }),
  }) });
  await assert.rejects(requireGreenCi(f.options));
  assert.ok(f.calls.some(({ url }) => url.searchParams.get("page") === "2"));
});

test("hung requests and response bodies abort within their deadline", async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  ]) {
    const f = fixture();
    await assert.rejects(requireGreenCi({ ...f.options, fetchImpl, requestTimeoutMs: 5 }), /request failed/i);
  }
});

test("unsafe/missing identity, token and unbounded timing inputs are rejected before requests", async () => {
  for (const patch of [
    { repository: "../other" }, { repository: "owner/product/extra" }, { sha: "main" },
    { token: "" }, { timeoutMs: Infinity }, { timeoutMs: 1_800_001 }, { pollIntervalMs: 0 },
  ]) {
    const f = fixture();
    await assert.rejects(requireGreenCi({ ...f.options, ...patch }));
    assert.equal(f.calls.length, 0);
  }
});

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function blocks(source) {
  return Object.fromEntries([...source.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]]));
}
test("workflow contract gates both image writes and SSH, keeps triggers/pins/digests, and never waits inside CI", () => {
  const deploy = read(".github/workflows/deploy.yml");
  const ci = read(".github/workflows/ci.yml");
  const jobs = blocks(deploy.slice(deploy.indexOf("jobs:\n")));
  assert.match(jobs["require-green-ci"], /actions: read/);
  assert.match(jobs["require-green-ci"], /contents: read/);
  assert.doesNotMatch(jobs["require-green-ci"], /packages: write|secrets\./);
  assert.match(jobs["require-green-ci"], /node scripts\/require-green-ci\.mjs/);
  assert.match(jobs["build-images"], /needs: require-green-ci/);
  assert.match(jobs.deploy, /needs: build-images/);
  assert.match(jobs.deploy, /actions: read/);
  assert.ok(jobs.deploy.indexOf("node scripts/require-green-ci.mjs") < jobs.deploy.indexOf("- name: Download immutable image digests"));
  assert.match(jobs.deploy, /node scripts\/require-green-ci\.mjs/);
  assert.doesNotMatch(ci, /run: node scripts\/require-green-ci\.mjs/);
  assert.match(deploy, /branches: \[main\]/);
  assert.match(deploy, /tags: \["v\*"\]/);
  assert.match(deploy, /paths-ignore:\n      - "\.github\/workflows\/\*\*"/);
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /SSH_HOST_KEY_SHA256: \$\{\{ secrets\.LIGHTSAIL_HOST_KEY_SHA256 \}\}/);
  assert.match(deploy, /API_IMAGE_REF=.*\/api@\$\{api_digest\}/);
  assert.match(deploy, /UI_IMAGE_REF=.*\/ui@\$\{ui_digest\}/);
});

test("all ten CI jobs are useful-step gated, contracts are hard Node22 jobs, watchdog observes nine siblings", () => {
  const ci = read(".github/workflows/ci.yml");
  const jobs = blocks(ci.slice(ci.indexOf("jobs:\n")));
  assert.equal(Object.keys(jobs).length, 10);
  for (const [name, steps] of Object.entries(jobSteps)) {
    const body = Object.values(jobs).find((job) => job.includes(`name: ${name}\n`));
    assert.ok(body, `missing CI job ${name}`);
    for (const step of steps) assert.ok(body.includes(`- name: ${step}\n`), `missing ${name}/${step}`);
  }
  const contracts = jobs["release-contracts"];
  assert.match(contracts, /node-version: 22/);
  assert.doesNotMatch(contracts, /^\s+(?:continue-on-error|if|needs):/m);
  assert.match(contracts, /uses: actions\/checkout@v4\n        with:\n(?:\s*#[^\n]*\n)*          fetch-depth: 0/);
  assert.match(contracts, /node --test scripts\/require-green-ci\.test\.mjs scripts\/public-claims\.test\.mjs scripts\/deploy-platform\.test\.mjs/);
  assert.match(contracts, /node --experimental-strip-types --test packages\/ui\/lib\/brandMotion\.test\.mjs/);
  const watchdog = jobs["workflow-watchdog"];
  const needs = [...watchdog.matchAll(/^      - ([\w-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(needs.sort(), Object.keys(jobs).filter((key) => key !== "workflow-watchdog").sort());
  assert.match(watchdog, /length == 9 and all\(\.value\.result == "success"\)/);
  assert.match(watchdog, /if: always\(\) && github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  let worstCaseMinutes = 0;
  for (const body of Object.values(jobs)) {
    assert.match(body, /runs-on: ubuntu-latest/);
    const timeout = Number(body.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(timeout > 0 && timeout <= 30);
    worstCaseMinutes += timeout;
  }
  assert.ok(worstCaseMinutes <= 300);
  for (const match of ci.matchAll(/retention-days: (\d+)/g)) assert.ok(Number(match[1]) <= 3);
});
