import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PUBLIC_SOURCE_PATHS = [
  "packages/ui/app/page.tsx",
  "packages/ui/app/pricing/page.tsx",
  "packages/ui/app/features/page.tsx",
  "packages/ui/app/docs/content.ts",
  "packages/ui/app/security/page.tsx",
  "packages/ui/app/layout.tsx",
  "packages/ui/app/pricing/layout.tsx",
  "packages/ui/app/docs/[slug]/page.tsx",
  "packages/ui/app/about/page.tsx",
  "packages/ui/app/cost-calculator/page.tsx",
  "packages/ui/app/cost-calculator/layout.tsx",
  "packages/ui/app/changelog/page.tsx",
  "packages/ui/app/blog/posts.ts",
  "packages/ui/app/compare/page.tsx",
  "packages/ui/app/docs/page.tsx",
  "packages/ui/app/blog/page.tsx",
  "packages/ui/app/blog/[slug]/page.tsx",
  "packages/ui/app/blog/layout.tsx",
  "packages/ui/app/contact/page.tsx",
  "packages/ui/app/contact/layout.tsx",
  "packages/ui/app/cookies/page.tsx",
  "packages/ui/app/cookies/layout.tsx",
  "packages/ui/app/kvkk/page.tsx",
  "packages/ui/app/kvkk/layout.tsx",
  "packages/ui/app/privacy/page.tsx",
  "packages/ui/app/privacy/layout.tsx",
  "packages/ui/app/terms/page.tsx",
  "packages/ui/app/terms/layout.tsx",
  "packages/ui/app/legal/account-deletion/page.tsx",
  "packages/ui/app/legal/account-deletion/layout.tsx",
  "packages/ui/app/status/layout.tsx",
  "packages/ui/app/support/page.tsx",
  "packages/ui/app/install/route.ts",
];

const LOCALE_MESSAGE_PATHS = [
  "packages/ui/messages/ar.json",
  "packages/ui/messages/de.json",
  "packages/ui/messages/en.json",
  "packages/ui/messages/es.json",
  "packages/ui/messages/fr.json",
  "packages/ui/messages/tr.json",
];

const SURFACE_SOURCE_PATHS = [
  "packages/ui/lib/surface-domain.ts",
  "packages/ui/middleware.ts",
  "ENV/nginx/Caddyfile",
  "ENV/nginx/braavolabs.conf",
];

const APPROVED_TRUTH = [
  "Individual — $19/month",
  "Team — $39/active-user/month",
  "Inference is not included. Use your own provider keys (BYOK) or local models.",
  "Private Mode keeps prompt, output, and artifact content end-to-end encrypted so Braavolabs cloud cannot read the plaintext.",
  "Cloud Agent Mode processes the content needed to run the task in Braavolabs execution infrastructure with explicit consent and visible retention.",
  "Holding — premium/private preview",
  "Signed evidence — in development",
  "cross-vendor AI workbench and control plane",
];

const FORBIDDEN_CLAIMS = [
  ["retired plan label Free", /\bFree\b/gi],
  ["retired plan label Creator", /\bCreator\b/g],
  ["retired plan label Pro", /\bPro\b/g],
  ["retired plan label Business", /\bBusiness\b/g],
  ["retired plan label Enterprise", /\bEnterprise\b/g],
  ["retired no-cost CTA", /\b(?:start|try)(?: Braavolabs)? free\b/gi],
  ["retired no-card CTA", /\bno (?:credit )?card(?: needed|required)?\b/gi],
  ["trial claim", /\btrial\b/gi],
  ["three-run trial", /\b(?:3|three|first three)\s+(?:free\s+|trial\s+)?runs?\b/gi],
  ["per-run price", /\$0\.30\b/g],
  ["managed inference", /\bmanaged inference\b/gi],
  ["system inference", /\bsystem inference\b/gi],
  ["hosted inference", /\bhosted inference\b/gi],
  ["platform-funded inference", /\bplatform-owned Groq(?: pool)?\b/gi],
  ["38 percent saving", /\b38\s*%/g],
  ["fully replayable", /\bfully replayable\b/gi],
  ["fully audited", /\bfully[- ]audited\b/gi],
  ["fully offline", /\bfully offline\b/gi],
  ["on-device claim", /\bon-device\b/gi],
  ["zero data egress", /\b(?:zero|no) data egress\b/gi],
  ["zero token cost", /\bzero token cost\b/gi],
  ["Gemma delivery claim", /\b(?:offline|on-device|local)\s+Gemma\b|\bGemma\s+(?:inference|model)\b/gi],
  ["encrypted offline bundle", /\bencrypted offline (?:export )?bundle\b/gi],
  ["machine-bound bundle", /\bmachine-bound (?:encrypted )?bundle\b/gi],
  ["air-gapped", /\bair[ -]?gapped\b/gi],
  ["unverified provider count", /\b\d+\s+providers?\b/gi],
  ["spelled-out provider count", /\b(?:twelve|fourteen)\s+providers?\b/gi],
  ["retired Team price unit", /\$39\/user\/month\b/g],
  ["unverified compliance claim", /\bKVKK \+ GDPR compliant\b/g],
];

const ROUTE_METADATA_CONTRACTS = {
  "/cost-calculator": {
    sourcePath: "packages/ui/app/cost-calculator/layout.tsx",
    forbidden: [
      ["per-task automation comparison", /\bper-task (?:automation|metering)\b/i],
      ["competitor comparison", /\bcompetitor(?: figures?)?\b/i],
      ["run-volume slider", /\b(?:run volume|slide your)\b/i],
      ["unsupported cost-difference claim", /\bcost difference\b/i],
    ],
  },
  "/status": {
    sourcePath: "packages/ui/app/status/layout.tsx",
    forbidden: [
      ["pipeline-worker coverage", /\bpipeline worker\b/i],
      ["webhook coverage", /\bwebhook delivery\b/i],
      ["authentication coverage", /\bauthentication\b/i],
      ["billing coverage", /\bbilling\b/i],
      ["incident-history coverage", /\bincident (?:history|timeline)\b/i],
    ],
  },
};

const PUBLIC_RENDER_ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/security",
  "/docs",
  "/about",
  "/blog",
  "/contact",
  "/cookies",
  "/cost-calculator",
  "/changelog",
  "/compare",
  "/kvkk",
  "/privacy",
  "/terms",
  "/legal/account-deletion",
  "/status",
  "/support",
];

const EXPECTED_STATIC_PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/security",
  "/docs",
  "/about",
  "/blog",
  "/contact",
  "/cookies",
  "/cost-calculator",
  "/changelog",
  "/compare",
  "/kvkk",
  "/privacy",
  "/terms",
  "/legal/account-deletion",
  "/status",
  "/support",
];

const EXPECTED_DOC_SLUGS = [
  "getting-started",
  "concepts",
  "byok-and-providers",
  "mid-run-steering",
  "webhooks",
  "external-automations",
  "mobile-app",
  "faq",
];

const EXPECTED_BLOG_SLUGS = [
  "steer-agents-mid-run",
  "five-risk-stops-explained",
  "byok-routing-without-lock-in",
  "pocket-steering",
  "local-model-routing-boundaries",
  "shipping-ask-user",
  "audit-trail-youd-actually-read",
];

const RETIRED_LOCALIZED_FREE_TERMS = /free|kostenlos|gratuit|gratuito|ücretsiz|مجاني/iu;
// Clean builds on this workspace have crossed 15 minutes under load; keep the
// lifecycle bounded without misclassifying observed page-generation work as a hang.
const BUILD_TIMEOUT_MS = 1_200_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_SERVER_READY_TIMEOUT_MS = 120_000;
const CHILD_TERMINATION_GRACE_MS = 10_000;
const PROCESS_GROUP_POLL_MS = 50;
const LIFECYCLE_HARNESS_COMMAND_TIMEOUT_MS = 20_000;
const LIFECYCLE_HARNESS_READY_TIMEOUT_MS = 30_000;
const LIFECYCLE_HARNESS_BUILD_TIMEOUT_MS = 2_000;
const LIFECYCLE_HARNESS_CASE_TIMEOUT_MS =
  LIFECYCLE_HARNESS_BUILD_TIMEOUT_MS + CHILD_TERMINATION_GRACE_MS * 2 + 5_000;
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM"];

let localServer;
let localServerError;
let localServerLogs = "";
let publicClaimsBaseUrl = process.env.PUBLIC_CLAIMS_BASE_URL;
let cleanupPromise;
let processExitCleanupStarted = false;
let lifecycleProofComplete = false;
let uncaughtExceptionHandler;
let unhandledRejectionHandler;
const trackedChildren = new Set();
const trackedProcessGroups = new Map();
const cleanupSignalHandlers = new Map();

function read(path) {
  const absolute = join(ROOT, path);
  assert.ok(existsSync(absolute), `${path} must exist`);
  return readFileSync(absolute, "utf8");
}

function sourceBundle(paths) {
  return paths.map((path) => `\n/* ${path} */\n${read(path)}`).join("\n");
}

function canonicalForRoute(route) {
  return route === "/" ? "https://www.braavolabs.com" : `https://www.braavolabs.com${route}`;
}

function termsForLocale(path) {
  const messages = JSON.parse(read(path));
  const terms = messages?.static?.legal?.terms;
  assert.ok(terms && Array.isArray(terms.sections), `${path} must contain static.legal.terms.sections`);
  return terms;
}

function slugsFrom(path) {
  return [...read(path).matchAll(/\bslug:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function assertPublicCorpusIntegrity({
  staticRoutes = PUBLIC_RENDER_ROUTES,
  docSlugs = slugsFrom("packages/ui/app/docs/content.ts"),
  blogSlugs = slugsFrom("packages/ui/app/blog/posts.ts"),
} = {}) {
  assert.deepEqual(staticRoutes, EXPECTED_STATIC_PUBLIC_ROUTES, "static public route corpus drift");
  assert.deepEqual(docSlugs, EXPECTED_DOC_SLUGS, "docs slug corpus drift");
  assert.deepEqual(blogSlugs, EXPECTED_BLOG_SLUGS, "blog slug corpus drift");
  return [
    ...staticRoutes,
    ...docSlugs.map((slug) => `/docs/${slug}`),
    ...blogSlugs.map((slug) => `/blog/${slug}`),
  ];
}

function assertRouteMetadataSource() {
  for (const [route, contract] of Object.entries(ROUTE_METADATA_CONTRACTS)) {
    const source = read(contract.sourcePath);
    for (const [label, pattern] of contract.forbidden) {
      assert.doesNotMatch(source, pattern, `${route} metadata claims unsupported ${label}`);
    }
  }
}

function requestPublic(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  assert.equal(url.protocol, "http:", "local rendered-claim test expects an HTTP test server");

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: "www.braavolabs.com", "X-Forwarded-Proto": "https" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`HTTP request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms: ${url.pathname}`));
    });
    request.end();
  });
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: process.env,
    ...options,
  });
  trackedChildren.add(child);
  trackedProcessGroups.set(child, {
    pgid: process.platform === "win32" ? undefined : child.pid,
    knownPids: new Set(child.pid ? [child.pid] : []),
  });
  child.once("error", () => {
    if (!child.pid) {
      trackedChildren.delete(child);
      trackedProcessGroups.delete(child);
    }
  });
  return child;
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise({ timedOut: true }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise({ timedOut: false, value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function processTable() {
  if (process.platform === "win32") return [];
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      command: match[4],
    }));
}

function captureTrackedProcessGroup(child) {
  const tracked = trackedProcessGroups.get(child);
  if (!tracked || process.platform === "win32") return [];
  const table = processTable();
  const root = table.find((entry) => entry.pid === child.pid);
  if (root) tracked.pgid = root.pgid;
  const treePids = new Set(tracked.knownPids);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const entry of table) {
      if (treePids.has(entry.ppid) && !treePids.has(entry.pid)) {
        treePids.add(entry.pid);
        expanded = true;
      }
    }
  }
  const members = table.filter((entry) => entry.pgid === tracked.pgid || treePids.has(entry.pid));
  for (const member of members) tracked.knownPids.add(member.pid);
  return members;
}

function processGroupIsAlive(pgid) {
  if (!pgid || process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(child, timeoutMs) {
  const tracked = trackedProcessGroups.get(child);
  if (!tracked || process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const result = await settleWithin(once(child, "exit"), timeoutMs);
    return !result.timedOut;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    captureTrackedProcessGroup(child);
    if (!processGroupIsAlive(tracked.pgid)) return true;
    await delay(PROCESS_GROUP_POLL_MS);
  }
  captureTrackedProcessGroup(child);
  return !processGroupIsAlive(tracked.pgid);
}

function signalTrackedProcessGroup(child, signal) {
  const tracked = trackedProcessGroups.get(child);
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return;
  }
  if (!tracked || !processGroupIsAlive(tracked.pgid)) return;
  try {
    process.kill(-tracked.pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertKnownProcessesGone(child, label) {
  const tracked = trackedProcessGroups.get(child);
  if (!tracked) return;
  const survivors = [...tracked.knownPids].filter(processIsAlive);
  assert.deepEqual(survivors, [], `${label} left known descendant PID(s): ${survivors.join(", ")}`);
  if (tracked.pgid) assert.equal(processGroupIsAlive(tracked.pgid), false, `${label} left process group ${tracked.pgid}`);
}

function releaseTrackedChild(child, label) {
  captureTrackedProcessGroup(child);
  assertKnownProcessesGone(child, label);
  trackedChildren.delete(child);
  trackedProcessGroups.delete(child);
}

async function terminateTrackedChild(child, signal = "SIGTERM") {
  if (!child) return;
  captureTrackedProcessGroup(child);
  signalTrackedProcessGroup(child, signal);

  let exited = await waitForProcessGroupExit(child, CHILD_TERMINATION_GRACE_MS);
  if (!exited) {
    signalTrackedProcessGroup(child, "SIGKILL");
    exited = await waitForProcessGroupExit(child, CHILD_TERMINATION_GRACE_MS);
    assert.equal(
      exited,
      true,
      `child process group ${trackedProcessGroups.get(child)?.pgid ?? child.pid} resisted SIGKILL`,
    );
  }
  assertKnownProcessesGone(child, `child process group ${trackedProcessGroups.get(child)?.pgid ?? child.pid}`);
  trackedChildren.delete(child);
  trackedProcessGroups.delete(child);
}

function cleanupTrackedChildren() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = Promise.allSettled([...trackedChildren].map((child) => terminateTrackedChild(child)))
    .then((results) => {
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "failed to clean public-claims child processes");
    })
    .finally(() => {
      cleanupPromise = undefined;
    });
  return cleanupPromise;
}

function unregisterProcessCleanupHandlers() {
  for (const [signal, handler] of cleanupSignalHandlers) process.off(signal, handler);
  cleanupSignalHandlers.clear();
  if (uncaughtExceptionHandler) process.off("uncaughtException", uncaughtExceptionHandler);
  if (unhandledRejectionHandler) process.off("unhandledRejection", unhandledRejectionHandler);
  uncaughtExceptionHandler = undefined;
  unhandledRejectionHandler = undefined;
}

function registerProcessCleanupHandlers() {
  if (cleanupSignalHandlers.size > 0) return;
  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => {
      if (processExitCleanupStarted) return;
      processExitCleanupStarted = true;
      void cleanupTrackedChildren()
        .catch((error) => console.error(error))
        .finally(() => {
          unregisterProcessCleanupHandlers();
          process.kill(process.pid, signal);
        });
    };
    cleanupSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const exitAfterCleanup = (reason) => {
    if (processExitCleanupStarted) return;
    processExitCleanupStarted = true;
    void cleanupTrackedChildren()
      .catch((error) => console.error(error))
      .finally(() => {
        unregisterProcessCleanupHandlers();
        console.error(reason);
        process.exit(1);
      });
  };
  uncaughtExceptionHandler = (error) => exitAfterCleanup(error);
  unhandledRejectionHandler = (reason) => exitAfterCleanup(reason);
  process.on("uncaughtException", uncaughtExceptionHandler);
  process.on("unhandledRejection", unhandledRejectionHandler);
}

async function runCommand(
  command,
  args,
  label,
  {
    timeoutMs = BUILD_TIMEOUT_MS,
    timeoutAfter = Promise.resolve(),
    stdio = "inherit",
    env = process.env,
    onSpawn,
  } = {},
) {
  const child = spawnTracked(command, args, {
    cwd: ROOT,
    env,
    stdio,
  });
  onSpawn?.(child);
  const completion = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  await timeoutAfter;
  const result = await settleWithin(completion, timeoutMs);
  if (result.timedOut) {
    await terminateTrackedChild(child);
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  const { code, signal } = result.value;
  const groupExited = await waitForProcessGroupExit(child, 1_000);
  if (!groupExited) {
    const tracked = trackedProcessGroups.get(child);
    const survivors = captureTrackedProcessGroup(child).map((entry) => entry.pid);
    await terminateTrackedChild(child);
    throw new Error(
      `${label} root exited but process group ${tracked?.pgid ?? child.pid} retained descendant PID(s): ${survivors.join(", ")}`,
    );
  }
  releaseTrackedChild(child, label);
  if (code !== 0) throw new Error(`${label} failed with exit ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
}

function reserveDynamicPort() {
  return new Promise((resolvePromise, reject) => {
    const reservation = createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      assert.ok(address && typeof address === "object", "dynamic port reservation must expose an address");
      reservation.close((error) => {
        if (error) reject(error);
        else resolvePromise(address.port);
      });
    });
  });
}

async function waitForPublicServer(baseUrl) {
  const deadline = Date.now() + LOCAL_SERVER_READY_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (localServerError) throw localServerError;
    if (!localServer || localServer.exitCode !== null || localServer.signalCode !== null) {
      throw new Error(`production server exited before readiness:\n${localServerLogs}`);
    }
    try {
      const response = await requestPublic(baseUrl, "/");
      if (response.status === 200 && response.headers["x-braavolabs-surface"] === "public") return;
      lastError = new Error(`unexpected readiness response: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(`production server readiness timed out: ${lastError?.message ?? "no response"}\n${localServerLogs}`);
}

async function assertListenerClosed(baseUrl) {
  await assert.rejects(
    requestPublic(baseUrl, "/"),
    /ECONNREFUSED|socket hang up|HTTP request timed out/,
    `forced cleanup left a listener at ${baseUrl}`,
  );
}

function listenerProbeArgs(port) {
  return [
    "-e",
    `const server = require("node:http").createServer((_, response) => { response.statusCode = 204; response.end(); }); server.listen(${port}, "127.0.0.1", () => { const address = server.address(); if (process.send) process.send({ type: "listener-ready", port: address.port }); });`,
  ];
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForTrackedCommand(child, pattern, timeoutMs = LIFECYCLE_HARNESS_COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastMembers = [];
  while (Date.now() < deadline) {
    lastMembers = captureTrackedProcessGroup(child);
    const match = lastMembers.find((entry) => pattern.test(entry.command));
    if (match) return match;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`tracked process group ${child.pid} exited before ${pattern} appeared`);
    }
    await delay(PROCESS_GROUP_POLL_MS);
  }
  throw new Error(
    `tracked process group ${child.pid} did not expose ${pattern} within ${timeoutMs}ms; observed:\n${lastMembers
      .map((entry) => `${entry.pid}/${entry.ppid}/${entry.pgid} ${entry.command}`)
      .join("\n")}`,
  );
}

async function waitForListenerReady(child) {
  const ready = new Promise((resolvePromise, reject) => {
    child.on("message", (message) => {
      if (message?.type === "listener-ready") resolvePromise(message);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`listener child exited before readiness: ${code ?? "null"}/${signal ?? "none"}`));
    });
  });
  const result = await settleWithin(ready, LIFECYCLE_HARNESS_READY_TIMEOUT_MS);
  if (result.timedOut) {
    await terminateTrackedChild(child);
    throw new Error(`listener child readiness timed out after ${LIFECYCLE_HARNESS_READY_TIMEOUT_MS}ms`);
  }
  return result.value;
}

async function runLifecycleHarness() {
  assert.notEqual(
    process.platform,
    "win32",
    "public-claims lifecycle subtree proof is POSIX-only; Windows requires a real subtree termination implementation",
  );
  registerProcessCleanupHandlers();
  const mode = process.env.PUBLIC_CLAIMS_HARNESS_MODE;
  assert.ok(
    ["timeout", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].includes(mode),
    `unsupported lifecycle harness mode: ${mode}`,
  );
  const listener = spawnTracked(process.execPath, listenerProbeArgs(0), {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const { port } = await waitForListenerReady(listener);
  const baseUrl = `http://127.0.0.1:${port}`;
  const listenerResponse = await requestPublic(baseUrl, "/");
  assert.equal(listenerResponse.status, 204, "lifecycle listener child must answer before the cleanup proof");

  let buildRoot;
  let armBuildTimeout;
  const buildTimeoutStart =
    mode === "timeout"
      ? new Promise((resolvePromise) => {
          armBuildTimeout = resolvePromise;
        })
      : Promise.resolve();
  const buildOutcome = runCommand(
    "pnpm",
    ["--filter", "@ai-company-os/ui", "build"],
    "lifecycle harness pnpm-to-next build",
    {
      timeoutMs: mode === "timeout" ? LIFECYCLE_HARNESS_BUILD_TIMEOUT_MS : BUILD_TIMEOUT_MS,
      timeoutAfter: buildTimeoutStart,
      stdio: "ignore",
      onSpawn: (child) => {
        buildRoot = child;
      },
    },
  ).then(
    () => ({ error: undefined }),
    (error) => ({ error }),
  );
  assert.ok(buildRoot, "lifecycle harness must retain the pnpm build root");
  const nextBuild = await waitForTrackedCommand(buildRoot, /\/next\/dist\/bin\/next\s+build(?:\s|$)/);
  const buildGroup = trackedProcessGroups.get(buildRoot);
  const listenerGroup = trackedProcessGroups.get(listener);
  armBuildTimeout?.();
  process.on("message", (message) => {
    if (message?.type !== "fatal") return;
    if (message.mode === "uncaughtException") {
      setImmediate(() => {
        throw new Error("forced lifecycle uncaughtException");
      });
    } else if (message.mode === "unhandledRejection") {
      setImmediate(() => {
        void Promise.reject(new Error("forced lifecycle unhandledRejection"));
      });
    }
  });
  assert.ok(process.send, "lifecycle harness requires an IPC channel");
  process.send({
    type: "ready",
    port,
    listenerPid: listener.pid,
    listenerGroupId: listenerGroup?.pgid,
    buildRootPid: buildRoot.pid,
    buildGroupId: buildGroup?.pgid,
    buildPids: [...(buildGroup?.knownPids ?? []), nextBuild.pid],
  });

  if (mode === "timeout") {
    const { error } = await buildOutcome;
    assert.match(
      error?.message ?? "",
      new RegExp(`lifecycle harness pnpm-to-next build timed out after ${LIFECYCLE_HARNESS_BUILD_TIMEOUT_MS}ms`),
    );
    await cleanupTrackedChildren();
    process.send({ type: "timeout-complete" });
    unregisterProcessCleanupHandlers();
    processExitCleanupStarted = false;
    process.disconnect();
    process.exit(0);
  }

  await new Promise(() => {});
}

async function waitForHarnessReady(child) {
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-8_192);
  });
  child.stderr.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-8_192);
  });
  const ready = new Promise((resolvePromise, reject) => {
    child.on("message", (message) => {
      if (message?.type === "ready") resolvePromise(message);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`lifecycle harness exited before readiness: ${code ?? "null"}/${signal ?? "none"}\n${logs}`));
    });
  });
  const result = await settleWithin(ready, LIFECYCLE_HARNESS_READY_TIMEOUT_MS);
  if (result.timedOut) {
    await terminateTrackedChild(child);
    throw new Error(`lifecycle harness readiness timed out after ${LIFECYCLE_HARNESS_READY_TIMEOUT_MS}ms\n${logs}`);
  }
  return result.value;
}

async function runRegisteredCleanupCase(mode) {
  assert.notEqual(
    process.platform,
    "win32",
    "public-claims lifecycle subtree proof is POSIX-only; Windows must not treat direct child.kill as subtree evidence",
  );
  const harness = spawnTracked(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      PUBLIC_CLAIMS_LIFECYCLE_HARNESS: "1",
      PUBLIC_CLAIMS_HARNESS_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const timeoutComplete = new Promise((resolvePromise) => {
    harness.on("message", (message) => {
      if (message?.type === "timeout-complete") resolvePromise();
    });
  });
  const ready = await waitForHarnessReady(harness);
  const exited = once(harness, "exit");

  if (mode === "SIGINT" || mode === "SIGTERM") {
    process.kill(harness.pid, mode);
  } else if (mode !== "timeout") {
    harness.send({ type: "fatal", mode });
  }

  if (mode === "timeout") {
    const completion = await settleWithin(timeoutComplete, LIFECYCLE_HARNESS_CASE_TIMEOUT_MS);
    assert.equal(completion.timedOut, false, "timeout lifecycle harness did not report completion");
  }
  const result = await settleWithin(exited, LIFECYCLE_HARNESS_CASE_TIMEOUT_MS);
  if (result.timedOut) {
    await terminateTrackedChild(harness);
    assert.fail(`${mode} lifecycle harness did not exit within ${LIFECYCLE_HARNESS_CASE_TIMEOUT_MS}ms`);
  }
  const [code, signal] = result.value;
  if (mode === "timeout") {
    assert.equal(code, 0, "timeout harness must exit 0 after proving its expected failure and cleanup");
    assert.equal(signal, null, "timeout harness must not mask cleanup with a signal");
  } else if (mode === "SIGINT" || mode === "SIGTERM") {
    assert.equal(code, null, `${mode} harness must exit by signal`);
    assert.equal(signal, mode, `${mode} harness must re-raise the received signal after cleanup`);
  } else {
    assert.equal(code, 1, `${mode} harness must exit 1 after cleanup`);
    assert.equal(signal, null, `${mode} harness must not mask the fatal exit with a signal`);
  }

  releaseTrackedChild(harness, `${mode} lifecycle harness`);
  await assertListenerClosed(`http://127.0.0.1:${ready.port}`);
  for (const pgid of [ready.listenerGroupId, ready.buildGroupId]) {
    assert.equal(processGroupIsAlive(pgid), false, `${mode} left descendant process group ${pgid} alive`);
  }
  for (const pid of [ready.listenerPid, ready.buildRootPid, ...ready.buildPids]) {
    assert.equal(processIsAlive(pid), false, `${mode} left descendant ${pid} alive`);
  }
  assert.equal(processIsAlive(harness.pid), false, `${mode} left harness ${harness.pid} alive`);
}

async function assertForcedLifecycleCleanup() {
  const preexistingChildren = new Set(trackedChildren);

  for (const mode of ["timeout", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]) {
    await runRegisteredCleanupCase(mode);
  }

  const leakedProbeChildren = [...trackedChildren].filter((child) => !preexistingChildren.has(child));
  assert.deepEqual(leakedProbeChildren, [], "forced timeout/interruption left a tracked child process");
}

if (process.env.PUBLIC_CLAIMS_LIFECYCLE_HARNESS === "1") {
  await runLifecycleHarness();
}

before(async () => {
  registerProcessCleanupHandlers();
  if (publicClaimsBaseUrl) return;

  await assertForcedLifecycleCleanup();
  lifecycleProofComplete = true;
  await runCommand("pnpm", ["--filter", "@ai-company-os/ui", "build"], "public claims production build");
  const port = await reserveDynamicPort();
  publicClaimsBaseUrl = `http://127.0.0.1:${port}`;
  localServer = spawnTracked(
    "pnpm",
    ["--filter", "@ai-company-os/ui", "exec", "next", "start", "--port", String(port)],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appendLog = (chunk) => {
    localServerLogs = `${localServerLogs}${chunk}`.slice(-32_768);
  };
  localServer.stdout.on("data", appendLog);
  localServer.stderr.on("data", appendLog);
  localServer.once("error", (error) => {
    localServerError = error;
  });

  try {
    await waitForPublicServer(publicClaimsBaseUrl);
  } catch (error) {
    await cleanupTrackedChildren();
    localServer = undefined;
    throw error;
  }
});

after(async () => {
  await cleanupTrackedChildren();
  localServer = undefined;
  unregisterProcessCleanupHandlers();
  processExitCleanupStarted = false;
});

test("public copy contains only the canonical price, inference, data-mode, and maturity truth", () => {
  const source = sourceBundle(PUBLIC_SOURCE_PATHS);
  const docSlugs = slugsFrom("packages/ui/app/docs/content.ts");
  const blogSlugs = slugsFrom("packages/ui/app/blog/posts.ts");

  assertPublicCorpusIntegrity({ docSlugs, blogSlugs });
  assert.throws(
    () => assertPublicCorpusIntegrity({ staticRoutes: PUBLIC_RENDER_ROUTES.slice(0, -1), docSlugs, blogSlugs }),
    /static public route corpus drift/,
  );
  assert.throws(
    () => assertPublicCorpusIntegrity({ docSlugs: docSlugs.slice(0, -1), blogSlugs }),
    /docs slug corpus drift/,
  );
  assert.throws(
    () => assertPublicCorpusIntegrity({ docSlugs, blogSlugs: blogSlugs.slice(0, -1) }),
    /blog slug corpus drift/,
  );
  assertRouteMetadataSource();

  for (const sentence of APPROVED_TRUTH) {
    assert.ok(source.includes(sentence), `missing canonical public truth: ${sentence}`);
  }

  for (const [label, pattern] of FORBIDDEN_CLAIMS) {
    const matches = [...source.matchAll(pattern)];
    assert.equal(matches.length, 0, `${label} remains public (${matches.length} match(es))`);
  }
});

test("all six locale Terms expose only the Individual and Team contract", () => {
  for (const path of LOCALE_MESSAGE_PATHS) {
    const terms = termsForLocale(path);
    const source = JSON.stringify(terms);
    assert.doesNotMatch(source, RETIRED_LOCALIZED_FREE_TERMS, `${path} still describes a free plan`);
    assert.doesNotMatch(source, /\b10\s+(?:runs?|executions?)\b/i, `${path} still describes retired run limits`);
    assert.match(source, /Individual/);
    assert.match(source, /Team/);
    assert.match(source, /\$19\/month/);
    assert.match(source, /\$39\/active-user\/month/);
  }
});

test("public pages cannot leak unresolved i18n keys or authenticated fetches", () => {
  const features = read("packages/ui/app/features/page.tsx");
  const source = sourceBundle(PUBLIC_SOURCE_PATHS);

  assert.doesNotMatch(features, /useTranslations|\bt\s*\(/, "features must render frozen copy, not unresolved runtime keys");
  assert.doesNotMatch(source, /\bfeatures\.[a-zA-Z0-9_.-]+\b/, "unresolved features.* key is present in render source");
  assert.doesNotMatch(source, /fetch\s*\(\s*["'`]\/api\/v1\/(?:dashboard|companies|runs|billing)/, "public source fetches tenant data");
});

test("all public login, signup, and launch links target the authenticated product host", () => {
  const source = sourceBundle(PUBLIC_SOURCE_PATHS);
  const apexUrls = [...source.matchAll(/https:\/\/braavolabs\.com\/[^"'\s]*/g)].map((match) => match[0]);

  assert.doesNotMatch(source, /href\s*=\s*["']\/(?:login|register|signup|dashboard|runs)\b/, "relative authenticated link remains on www");
  assert.deepEqual(apexUrls, [], `apex URLs remain in public source:\n${apexUrls.join("\n")}`);
  assert.doesNotMatch(source, /href\s*=\s*["']\/download\b/, "public source links to the missing download route");
  for (const url of [
    "https://app.braavolabs.com/login",
    "https://app.braavolabs.com/register",
    "https://app.braavolabs.com/dashboard",
  ]) {
    assert.ok(source.includes(url), `missing authenticated-host link: ${url}`);
  }
});

test("the unpublished CLI endpoint is fail-closed and non-executable", () => {
  const installRoute = read("packages/ui/app/install/route.ts");
  assert.doesNotMatch(installRoute, /#!\/bin\/sh|npm install\s+-g|application\/x-sh|text\/x-shellscript/);
  assert.match(installRoute, /status:\s*503/);
  assert.match(installRoute, /not publicly available/i);
  assert.match(installRoute, /https:\/\/www\.braavolabs\.com\/docs\/getting-started/);
});

test("surface contract redirects before render and edge configs isolate cookies, CSP, and CORS", async () => {
  const surface = read("packages/ui/lib/surface-domain.ts");
  const middleware = read("packages/ui/middleware.ts");
  const caddy = read("ENV/nginx/Caddyfile");
  const nginx = read("ENV/nginx/braavolabs.conf");

  assert.match(surface, /www\.braavolabs\.com/);
  assert.match(surface, /app\.braavolabs\.com/);
  assert.match(surface, /export function (?:classifySurfacePath|getSurfaceRedirect)/);
  assert.match(middleware, /NextResponse\.redirect\([^\n]+308\)/, "wrong-surface redirect must be canonical 308");
  assert.match(middleware, /getSurfaceRedirect/);
  assert.match(middleware, /x-braavolabs-surface/);

  assert.match(caddy, /header_down -Set-Cookie/, "www must not forward upstream cookies");
  assert.match(caddy, /https:\/\/api\.braavolabs\.com/, "app CSP/CORS contract must name the API origin");
  assert.match(nginx, /proxy_hide_header Set-Cookie/, "www must not forward upstream cookies");
  assert.match(nginx, /proxy_cookie_domain off/, "auth cookies must stay host-only");
  assert.match(nginx, /Access-Control-Allow-Origin "https:\/\/app\.braavolabs\.com"/, "API CORS must admit only the app origin");

  const lifecycle = read("scripts/public-claims.test.mjs");
  assert.match(lifecycle, /CLEANUP_SIGNALS = \["SIGINT", "SIGTERM"\]/);
  assert.match(lifecycle, /uncaughtException/);
  assert.match(lifecycle, /unhandledRejection/);
  assert.equal(lifecycleProofComplete, true, "real pnpm-to-next lifecycle proof must complete before the build gate");
});

test("built public route entrypoints contain canonical truth", () => {
  const files = [
    "packages/ui/.next/server/app/page.js",
    "packages/ui/.next/server/app/page.js.map",
    "packages/ui/.next/server/app/pricing/page.js",
    "packages/ui/.next/server/app/pricing/page.js.map",
    "packages/ui/.next/server/app/features/page.js",
    "packages/ui/.next/server/app/features/page.js.map",
    "packages/ui/.next/server/app/docs/[slug]/page.js",
    "packages/ui/.next/server/app/docs/[slug]/page.js.map",
    "packages/ui/.next/server/app/security/page.js",
    "packages/ui/.next/server/app/security/page.js.map",
    "packages/ui/.next/server/app/about/page.js",
    "packages/ui/.next/server/app/about/page.js.map",
    "packages/ui/.next/server/app/cost-calculator/page.js",
    "packages/ui/.next/server/app/cost-calculator/page.js.map",
    "packages/ui/.next/server/app/changelog/page.js",
    "packages/ui/.next/server/app/changelog/page.js.map",
    "packages/ui/.next/server/app/blog/[slug]/page.js",
    "packages/ui/.next/server/app/blog/[slug]/page.js.map",
    "packages/ui/.next/server/app/compare/page.js",
    "packages/ui/.next/server/app/compare/page.js.map",
    "packages/ui/.next/server/app/docs/page.js",
    "packages/ui/.next/server/app/docs/page.js.map",
    "packages/ui/.next/server/app/blog/page.js",
    "packages/ui/.next/server/app/blog/page.js.map",
    "packages/ui/.next/server/app/contact/page.js",
    "packages/ui/.next/server/app/contact/page.js.map",
    "packages/ui/.next/server/app/cookies/page.js",
    "packages/ui/.next/server/app/cookies/page.js.map",
    "packages/ui/.next/server/app/kvkk/page.js",
    "packages/ui/.next/server/app/kvkk/page.js.map",
    "packages/ui/.next/server/app/privacy/page.js",
    "packages/ui/.next/server/app/privacy/page.js.map",
    "packages/ui/.next/server/app/terms/page.js",
    "packages/ui/.next/server/app/terms/page.js.map",
    "packages/ui/.next/server/app/legal/account-deletion/page.js",
    "packages/ui/.next/server/app/legal/account-deletion/page.js.map",
    "packages/ui/.next/server/app/support/page.js",
    "packages/ui/.next/server/app/support/page.js.map",
    "packages/ui/.next/server/app/install/route.js",
    "packages/ui/.next/server/app/install/route.js.map",
  ];
  const output = files.map((path) => `\n/* ${path} */\n${read(path)}`).join("\n");
  assert.ok(output.includes("Individual"), "built output is missing Individual pricing");
  assert.ok(output.includes("$19/month"), "built output is missing the Individual price");
  assert.ok(output.includes("$39/active-user/month"), "built output is missing the Team price");
  for (const [label, pattern] of FORBIDDEN_CLAIMS) {
    const matches = [...output.matchAll(pattern)];
    assert.equal(matches.length, 0, `${label} remains in built public entrypoints (${matches.length} match(es))`);
  }
  assert.doesNotMatch(output, /href\s*:\s*["']\/(?:login|register|signup|dashboard|runs)\b/, "built output contains a relative auth link");
  const featuresOutput = files
    .filter((path) => path.includes("/features/"))
    .map((path) => read(path))
    .join("\n");
  assert.doesNotMatch(featuresOutput, /\bfeatures\.[a-zA-Z0-9_.-]+\b/, "built feature entrypoint contains an unresolved i18n key");
});

test("production-rendered public HTML contains only the frozen public truth", async () => {
  assert.ok(publicClaimsBaseUrl, "public claims lifecycle must provide a rendered base URL");
  const baseUrl = publicClaimsBaseUrl;
  const rendered = [];
  const findings = [];

  for (const route of assertPublicCorpusIntegrity()) {
    const response = await requestPublic(baseUrl, route);
    assert.equal(response.status, 200, `${route} must render on the public host`);
    assert.equal(response.headers["x-braavolabs-surface"], "public", `${route} must use the public surface`);
    assert.equal(response.headers["set-cookie"], undefined, `${route} must not set an auth cookie`);
    const body = response.body;
    const expectedCanonical = canonicalForRoute(route);
    const canonical = body.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
    const ogUrl = body.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1];
    if (canonical !== expectedCanonical) {
      findings.push(`${route}: canonical ${canonical ?? "missing"} (expected ${expectedCanonical})`);
    }
    if (ogUrl !== expectedCanonical) {
      findings.push(`${route}: og:url ${ogUrl ?? "missing"} (expected ${expectedCanonical})`);
    }
    const metadataContract = ROUTE_METADATA_CONTRACTS[route];
    if (metadataContract) {
      const description = body.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? "";
      const ogDescription = body.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1] ?? "";
      const metadata = `${description}\n${ogDescription}`;
      for (const [label, pattern] of metadataContract.forbidden) {
        if (pattern.test(metadata)) findings.push(`${route}: unsupported metadata ${label}`);
      }
    }
    rendered.push(`\n<!-- ${route} -->\n${body}`);
    for (const [label, pattern] of FORBIDDEN_CLAIMS) {
      const matches = [...body.matchAll(pattern)];
      if (matches.length > 0) findings.push(`${route}: ${label} (${matches.length})`);
    }
    if (/href=["']\/(?:login|register|signup|dashboard|runs)\b/.test(body)) {
      findings.push(`${route}: relative authenticated link`);
    }
    if (/\bfeatures\.[a-zA-Z0-9_.-]+\b/.test(body)) {
      findings.push(`${route}: unresolved i18n key`);
    }
  }

  const html = rendered.join("\n");
  for (const sentence of APPROVED_TRUTH) {
    assert.ok(html.includes(sentence), `rendered corpus is missing canonical public truth: ${sentence}`);
  }
  assert.deepEqual(findings, [], `rendered public corpus drift:\n${findings.join("\n")}`);

  const download = await requestPublic(baseUrl, "/download");
  assert.equal(download.status, 308, "/download must resolve canonically to existing documentation");
  assert.equal(download.headers.location, "https://www.braavolabs.com/docs/getting-started");

  const install = await requestPublic(baseUrl, "/install");
  assert.equal(install.status, 503, "/install must disclose that the CLI package is unavailable");
  assert.match(install.headers["content-type"] ?? "", /^text\/plain\b/);
  assert.match(install.body, /not publicly available/i);
  assert.doesNotMatch(install.body, /#!\/bin\/sh|npm install\s+-g/);

  const wrongSurface = await requestPublic(baseUrl, "/dashboard");
  assert.equal(wrongSurface.status, 308, "www tenant route must redirect before rendering");
  assert.equal(wrongSurface.headers.location, "https://app.braavolabs.com/dashboard");
  assert.equal(wrongSurface.headers["set-cookie"], undefined, "www tenant redirect must not set an auth cookie");
});
