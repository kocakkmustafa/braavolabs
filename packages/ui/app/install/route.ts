/**
 * The Braavolabs CLI package is not publicly available yet.
 *
 * Keep this route non-executable so an old `curl .../install | sh` command
 * cannot install an unpublished or unverified package. Public documentation
 * remains available while the download surface is gated for release.
 */
const UNAVAILABLE = [
  "Braavolabs CLI downloads are not publicly available yet.",
  "See https://www.braavolabs.com/docs/getting-started for current availability.",
  "",
].join("\n");

export async function GET() {
  return new Response(UNAVAILABLE, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "86400",
    },
  });
}
