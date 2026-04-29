import { redirect } from "next/navigation";

/**
 * /docs/api → /docs
 *
 * The main /docs page already serves as the API reference (Authentication,
 * Companies, Pipelines, Runs, Agents, etc. — see the in-page TOC). Users
 * who land on /docs/api expecting a Redoc-style spec are redirected to the
 * unified reference. When/if a separate Redoc-rendered spec ships, this
 * route can be replaced with the Redoc page directly.
 */
export default function ApiDocsRedirect() {
  redirect("/docs#auth-routes");
}
