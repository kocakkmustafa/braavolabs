const UNAVAILABLE = "The Braavolabs CLI installer is not publicly available. See /docs/getting-started.\n";

export async function GET() {
  return new Response(UNAVAILABLE, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
