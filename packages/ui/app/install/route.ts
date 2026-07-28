/**
 * `GET /install` — the script behind the homepage's install command.
 *
 * The homepage prints `curl -fsSL braavolabs.com/install | sh`. Until this
 * route existed that URL returned the 404 page, so anyone who copied the
 * command piped an HTML error document straight into their shell. That is the
 * hazard this file closes: the route must always answer with a real script.
 *
 * NOT to be confused with `scripts/install.sh` at the repo root — that one
 * stands up a self-hosted Braavolabs stack (Docker, Postgres, Redis). This one
 * installs the `braavo` CLI on a developer's machine, nothing more.
 *
 * The script is served as plain text and written for POSIX `sh`, not bash,
 * because that is what the published command pipes into. It is also meant to
 * be *read* — people do inspect what they pipe — so it stays short, avoids
 * clever shell, and never escalates privileges on its own.
 */

// The CLI is a Node package, so installation is `npm install -g`. Keeping the
// body here (rather than a file read) means the route works identically in dev,
// in `next build` output, and inside the standalone Docker image.
const SCRIPT = `#!/bin/sh
# Braavolabs CLI installer — https://braavolabs.com
#
# Usage:  curl -fsSL braavolabs.com/install | sh
# Pin a version:  curl -fsSL braavolabs.com/install | BRAAVO_VERSION=0.1.0 sh
#
# This script installs one npm package globally and does nothing else. It does
# not write to your shell profile, does not call sudo, and does not phone home.

set -e

PKG="@braavolabs/cli"
# Deliberately no 'set -u': an unset BRAAVO_VERSION must expand to empty so the
# check below can fall back, and the \${VAR:-default} form is avoided to keep
# this readable for people inspecting the script before running it.
if [ "x$BRAAVO_VERSION" = "x" ]; then
  BRAAVO_VERSION=latest
fi

say()  { printf '%s\\n' "$*"; }
fail() { printf 'braavo: %s\\n' "$*" >&2; exit 1; }

say "> braavolabs — installing the braavo CLI"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 18 or newer is required, but 'node' was not found on your PATH.
       Install it from https://nodejs.org and run this command again."
fi

# process.versions is used rather than parsing 'node -v' so the comparison does
# not depend on the leading 'v' or on any pre-release suffix.
NODE_MAJOR=\`node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0\`
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  fail "Node.js 18 or newer is required (found \`node -v\`). Upgrade Node and try again."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "'npm' was not found next to Node. Install npm and run this command again."
fi

say "  node \`node -v\` — installing $PKG@$BRAAVO_VERSION"

if ! npm install -g "$PKG@$BRAAVO_VERSION"; then
  fail "npm could not install $PKG.
       If the error above mentions EACCES, your global npm directory needs
       write access — see https://docs.npmjs.com/resolving-eacces-permissions-errors
       rather than re-running this script with sudo."
fi

# A successful npm install still leaves the command unusable if npm's global bin
# directory is not on PATH — a common state on fresh machines. Say so plainly
# instead of reporting success the user cannot act on.
if ! command -v braavo >/dev/null 2>&1; then
  NPM_BIN=\`npm prefix -g 2>/dev/null\`
  say ""
  say "  installed, but 'braavo' is not on your PATH yet."
  say "  add this to your shell profile, then open a new terminal:"
  say ""
  say "    export PATH=\\"$NPM_BIN/bin:\\$PATH\\""
  say ""
  exit 0
fi

say ""
say "  installed — \`braavo --version\`"
say "  next:  braavo --help"
say ""
`;

export async function GET() {
  return new Response(SCRIPT, {
    headers: {
      // text/plain, not text/x-shellscript: browsers render the former inline,
      // and people paste this URL into a browser to read it before trusting it.
      "content-type": "text/plain; charset=utf-8",
      // Short cache. Long enough to absorb a launch spike, short enough that a
      // fix to the installer reaches users the same day.
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
