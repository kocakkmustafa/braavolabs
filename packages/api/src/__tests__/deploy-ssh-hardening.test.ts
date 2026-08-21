import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

/**
 * Deploy SSH host-key invariant (BR-P0-005).
 *
 * The deploy job reaches a production Lightsail box over SSH. Until this
 * gate, it disabled host-key verification on every call while ALSO running
 * `ssh-keyscan` into known_hosts under a comment claiming that pinned the
 * host "to defeat MITM". Both halves were theater:
 *
 *   - the per-call option overrode known_hosts, so the file was written and
 *     then ignored;
 *   - keyscanning AT DEPLOY TIME is not pinning at all. It trusts whatever
 *     answers on that address during this run — precisely the traffic an
 *     on-path attacker controls — and whatever answers receives the deploy
 *     key, the ENV directory and a root-capable shell.
 *
 * This is the class BR-P1-005 closed in `requireRole`: a control that is
 * present, looks correct, and enforces nothing. So this gate does not grep
 * for the one spelling that happened to be used. It asserts the invariant:
 * host-key policy is defined ONCE, that definition is strict, and no call
 * site can reach the server except through it.
 *
 * ORDER MATTERS, and this cost a review round. ssh is FIRST-WINS: the first
 * value obtained for a parameter is the one used. Proven against a real
 * sshd with a wrong key pinned:
 *     ssh -o StrictHostKeyChecking=no $SSH_OPTS host  -> CONNECTED
 *     ssh $SSH_OPTS -o StrictHostKeyChecking=no host  -> refused
 * So "the line mentions $SSH_OPTS" is NOT the invariant. $SSH_OPTS must come
 * FIRST, before anything else can win the parameter.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Directories that cannot contain deploy logic and would dominate the walk. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "playwright-report",
  "test-results",
]);

type Source = { name: string; text: string };

/** Scripts identified by name rather than extension. */
const BY_NAME = new Set(["Makefile", "makefile", "GNUmakefile", "Dockerfile"]);

/**
 * Does this file need scanning?
 *
 * An extension allowlist was itself a hole: `scripts/deploy-remote` with a
 * shebang and no extension, a `Makefile`, a `.zsh` and a `.py` all evaded
 * (proven in review). So extensions are a fast path, and anything without
 * one is sniffed for `#!` — an executable script is an executable script
 * whatever it is called.
 */
function collects(abs: string, base: string): boolean {
  if (/\.(ya?ml|sh|bash|zsh|fish|ksh|mk|py|rb|pl)$/.test(base)) return true;
  if (BY_NAME.has(base)) return true;
  if (base.includes(".")) return false;
  // Extensionless: read the first two bytes only. Never slurp a binary.
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, 0);
    return buf.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Every file that could open a connection to the deploy target.
 *
 * Scanning only `.github/workflows` was a real hole (found in review):
 * moving the ssh into `scripts/deploy-remote.sh` and calling that script
 * from the workflow evaded the entire gate, and this repo already ships a
 * `scripts/` directory. Scripts anywhere count.
 */
function sources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, name);
      else if (collects(abs, entry.name)) {
        out.push({ name, text: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(ROOT, "");

  // A gate that silently sees nothing is worse than no gate.
  expect(
    out.some((s) => /\.github\/workflows\/deploy\.ya?ml$/.test(s.name)),
    `deploy workflow not found under ${ROOT} — this gate is not looking at anything`,
  ).toBe(true);
  return out;
}

/**
 * Physical lines joined on trailing backslashes, so a command split across
 * lines is analysed as the one command it actually is. Reported line number
 * is where the command STARTS.
 */
function logicalLines(text: string): Array<{ n: number; line: string }> {
  const raw = text.split("\n");
  const out: Array<{ n: number; line: string }> = [];
  let buf = "";
  let start = 0;
  raw.forEach((l, i) => {
    if (buf === "") start = i + 1;
    if (/\\\s*$/.test(l)) {
      buf += l.replace(/\\\s*$/, " ");
      return;
    }
    out.push({ n: start, line: buf + l });
    buf = "";
  });
  if (buf !== "") out.push({ n: start, line: buf });
  return out;
}

/**
 * Collapse the many spellings of one option. `-o Foo=no`, `-oFoo=no`,
 * `-o "Foo no"` and the ssh_config form `Foo no` all become `foo=no`.
 * Without this the gate checks a typo, not a policy.
 */
function normalise(line: string): string {
  return line
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/-o\s+/g, "-o")
    .replace(/([a-z]+)\s*=\s*/g, "$1=")
    .replace(/-o([a-z]+)\s+([a-z0-9/._-]+)/g, "-o$1=$2")
    // ssh_config space syntax, with no -o in front of it at all.
    .replace(/\b(stricthostkeychecking|userknownhostsfile)\s+(\S+)/g, "$1=$2");
}

const HARDENED = /^\$SSH_OPTS$|^\$\{SSH_OPTS\}$/;

/** Call sites: anything that opens a connection to the deploy target. */
function callSites(text: string): Array<{ n: number; line: string; args: string }> {
  const out: Array<{ n: number; line: string; args: string }> = [];
  for (const { n, line } of logicalLines(text)) {
    if (line.trim().startsWith("#")) continue;

    // ssh/scp/sftp in COMMAND position. The delimiter class includes `:`
    // and `-` on purpose: YAML's inline `run: ssh …` and list-item `- ssh …`
    // are command positions too, and leaving them out let a whole new step
    // walk past this gate (caught by the adversarial harness, not by
    // inspection). Over-matching prose here is the safe direction.
    const direct = line.match(/(?:^|[;&|(:-]|&&|\|\|)\s*(ssh|scp|sftp)\s+(.*)$/);
    if (direct) out.push({ n, line, args: direct[2] });

    // rsync counts whether it names ssh via -e or just addresses a remote
    // path. `rsync -az ./ user@host:/path` has no -e at all and was invisible
    // to the first version of this gate.
    const isRsync = /(?:^|[;&|(:-]|&&|\|\|)\s*rsync\s/.test(line);
    if (isRsync && (/-e\s+\S/.test(line) || /\S+@\S+:/.test(line))) {
      const e = line.match(/-e\s+["']?\s*ssh\s+([^"']*)["']?/);
      out.push({ n, line, args: e ? e[1] : "" });
    }
  }
  return out;
}

describe("deploy SSH hardening (BR-P0-005)", () => {
  it("never weakens host-key verification, in any spelling", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources()) {
      for (const { n, line } of logicalLines(text)) {
        if (line.trim().startsWith("#")) continue;
        const norm = normalise(line);
        const m = norm.match(/stricthostkeychecking=([a-z-]+)/);
        if (m && m[1] !== "yes") {
          offenders.push(`${name}:${n} host-key checking set to "${m[1]}": ${line.trim()}`);
        }
        if (/userknownhostsfile=\/dev\/null/.test(norm)) {
          offenders.push(`${name}:${n} known_hosts routed to /dev/null: ${line.trim()}`);
        }

        // Ordering was never the whole invariant. These options do not
        // CONTEST a parameter — they ADD a second source of trusted keys —
        // so first-wins does not defend against them. Proven in review
        // against a real sshd with a WRONG key pinned:
        //   ssh $SSH_OPTS -o GlobalKnownHostsFile=$attacker_store host
        // connects, with $SSH_OPTS still the literal first token.
        // Scanned on every line, so a nested remote command or an
        // ~/.ssh/config written in an earlier step is covered too.
        for (const opt of ["globalknownhostsfile", "knownhostscommand", "hostkeyalias"]) {
          if (norm.includes(opt)) {
            offenders.push(`${name}:${n} adds a second trust store via ${opt}: ${line.trim()}`);
          }
        }
        if (/proxycommand/.test(norm)) {
          offenders.push(`${name}:${n} reroutes the connection via ProxyCommand: ${line.trim()}`);
        }
        // -F substitutes a whole config file. Scoped to lines that actually
        // move traffic, because `ssh-keygen -F` (our own host-match check)
        // and `grep -F` are legitimate.
        if (
          /(^|\s)-F(\s|=)/.test(line) &&
          /\b(ssh|scp|sftp|rsync)\b/.test(line) &&
          !/ssh-keygen|ssh-keyscan/.test(line)
        ) {
          offenders.push(`${name}:${n} substitutes ssh_config with -F: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("lets nothing but the verified secret write the trust store", () => {
    // Structural rather than a keyword ban: `ssh-keyscan` in printed
    // instructions is harmless; keyscan output LANDING in known_hosts is the
    // defect. Phrasing cannot dodge a rule about writes.
    const offenders: string[] = [];
    for (const { name, text } of sources()) {
      for (const { n, line } of logicalLines(text)) {
        const t = line.trim();
        if (t.startsWith("#")) continue;
        if (/ssh-keyscan/.test(t) && /(>>?|\|\s*(tee|cat))/.test(t)) {
          offenders.push(`${name}:${n} keyscan output is being captured: ${t}`);
        }
        if (/known_hosts/.test(t) && /(^|[^>])>>?\s*\S*known_hosts/.test(t) && !/KNOWN_HOSTS/.test(t)) {
          offenders.push(
            `${name}:${n} writes known_hosts from something other than the verified secret: ${t}`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("puts $SSH_OPTS FIRST at every call site, because ssh is first-wins", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources()) {
      for (const { n, line, args } of callSites(text)) {
        const first = args.trim().split(/\s+/)[0] ?? "";
        if (!HARDENED.test(first)) {
          offenders.push(
            `${name}:${n} first argument is "${first}", not $SSH_OPTS — anything ` +
              `earlier wins the parameter and can disable host-key checking: ${line.trim()}`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("defines SSH_OPTS exactly once, and defines it strictly", () => {
    const defs: Array<{ where: string; value: string }> = [];
    for (const { name, text } of sources()) {
      for (const { n, line } of logicalLines(text)) {
        if (line.trim().startsWith("#")) continue;
        // Both the shell form (SSH_OPTS=…) and the YAML env form
        // (SSH_OPTS: …). The colon form slipped past the first version and
        // step-level env beats $GITHUB_ENV, so it could have shadowed the
        // real definition silently.
        // `+=` is a definition too: SSH_OPTS+=" -o GlobalKnownHostsFile=…"
        // leaves the counter seeing one definition while the appended
        // option wins a parameter nothing else checks.
        const m = line.match(/\bSSH_OPTS\s*(?:\+?=|:)\s*(.*)$/);
        if (m) defs.push({ where: `${name}:${n}`, value: m[1] });
      }
    }
    expect(
      defs.length,
      `expected exactly one SSH_OPTS definition, found ${defs.length}:\n` +
        defs.map((d) => `  ${d.where}: ${d.value}`).join("\n"),
    ).toBe(1);

    const { where, value } = defs[0];
    const norm = normalise(value);
    expect(norm, `${where}: SSH_OPTS must pin host-key checking`).toContain("stricthostkeychecking=yes");
    expect(norm, `${where}: SSH_OPTS must name the known_hosts file it trusts`).toMatch(
      /userknownhostsfile=\S+/,
    );
    expect(norm, `${where}: SSH_OPTS must run non-interactively (BatchMode)`).toContain("batchmode=yes");
    expect(norm, `${where}: SSH_OPTS must not point ssh at another config`).not.toMatch(/(^|\s)-f(\s|=)/);
  });

  it("fails closed when the pinned host key is missing or does not match the host", () => {
    const deploy = sources().find((s) => /\.github\/workflows\/deploy\.ya?ml$/.test(s.name))!;
    const lines = deploy.text.split("\n");

    expect(/KNOWN_HOSTS/.test(deploy.text), "deploy must source its host key from a KNOWN_HOSTS secret").toBe(true);

    // Structural, not a character budget: find the guard, walk to its
    // matching `fi`, require the abort inside. A fixed distance would
    // silently pass the day someone adds a line to the message.
    const guard = lines.findIndex((l) => /if\s+\[\s+-z\s+.*KNOWN_HOSTS/.test(l));
    expect(guard, "deploy must guard on an empty KNOWN_HOSTS secret").toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > guard && /^\s*fi\s*$/.test(l));
    expect(end, "the KNOWN_HOSTS guard has no closing fi").toBeGreaterThan(guard);
    expect(
      /^\s*exit\s+[1-9]/m.test(lines.slice(guard, end).join("\n")),
      "the KNOWN_HOSTS guard must abort the job, not just print a warning",
    ).toBe(true);

    // A non-empty secret is not enough: a line generated for a different
    // host or port makes ssh fail three steps later with an opaque
    // "Host key verification failed". Proven in review. Check the pin
    // matches the host we actually address, at setup time.
    expect(
      /ssh-keygen\s+-F\s/.test(deploy.text),
      "deploy must verify the pinned line actually matches LIGHTSAIL_HOST (ssh-keygen -F)",
    ).toBe(true);
  });
});
