import { expect, test } from "@playwright/test";
import { UI } from "./ports";

const API = /https:\/\/api\.operator\.example\/api\/v1\//;
const cors = {
  "Access-Control-Allow-Origin": UI,
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

test("draft review uses real statuses, owned active actions and authoritative delivery result", async ({ context, page }) => {
  await context.addInitScript(() => {
    localStorage.setItem("cookie_consent", "essential-only");
    localStorage.setItem("aicos-auth", JSON.stringify({
      state: { token: "synthetic-ui-token", refreshToken: null, tenantId: "tenant-1", theme: "dark" },
      version: 0,
    }));
  });
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });

  const companies = [
    { id: "company-active", name: "Active workspace", status: "ACTIVE" },
    { id: "company-archived", name: "Archived workspace", status: "ARCHIVED" },
  ];
  const email = {
    id: "email-1", companyId: "company-active", title: "Welcome email", type: "EMAIL", status: "PENDING",
    content: { to: "private@example.com", subject: "Internal subject", body: "Hello reviewer", hashtags: ["one"] },
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const social = {
    id: "social-1", companyId: "company-active", title: "Social draft", type: "SOCIAL_POST", status: "PENDING",
    content: { body: "Social body" }, createdAt: email.createdAt,
  };
  const foreign = {
    ...email, id: "foreign-1", companyId: "other-tenant-company", title: "Foreign draft",
  };
  const archivedEmail = {
    ...email, id: "archived-1", companyId: "company-archived", title: "Archived workspace draft",
  };
  const decisions: Array<{ id: string; body: unknown }> = [];

  await context.route(API, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const json = (body: unknown, status = 200) => route.fulfill({
      status, headers: cors, contentType: "application/json", body: JSON.stringify(body),
    });
    if (request.method() === "GET" && url.pathname.endsWith("/companies")) {
      await json(companies);
    } else if (request.method() === "GET" && url.pathname.endsWith("/drafts")) {
      await json(url.searchParams.get("companyId") === "company-archived"
        ? [archivedEmail] : [email, social, foreign]);
    } else if (request.method() === "POST" && url.pathname.endsWith("/approve")) {
      const id = url.pathname.split("/").at(-2)!;
      const body = request.postDataJSON();
      decisions.push({ id, body });
      await json(id === "email-1" ? { ...email, status: "PUBLISHED" } : { ...social, status: "APPROVED" });
    } else if (request.method() === "PATCH" && url.pathname.endsWith("/drafts/archived-1")) {
      await json({ ...archivedEmail, status: "REJECTED" });
    } else {
      await json({ error: "Unexpected fixture request" }, 404);
    }
  });

  await page.goto(`${UI}/drafts`);
  await expect(page.getByText("3 pending")).toBeVisible();
  await expect(page.getByText("Hello reviewer")).toBeVisible();
  await expect(page.getByText("#one")).toBeVisible();
  await expect(page.getByText("private@example.com")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and send" })).toBeVisible();

  await page.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByText("Sent or published")).toBeVisible();
  await expect(page.getByText("2 pending")).toBeVisible();
  expect(decisions).toEqual([{ id: "email-1", body: { send: true } }]);

  await page.getByRole("button", { name: /Social draft/ }).click();
  await expect(page.getByRole("button", { name: /Approve$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  await page.getByRole("button", { name: /Approve$/ }).click();
  await expect(page.getByText("Approved")).toBeVisible();
  expect(decisions.at(-1)).toEqual({ id: "social-1", body: { send: false } });

  await page.getByRole("button", { name: /Foreign draft/ }).click();
  await expect(page.getByRole("button", { name: /Approve$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);

  await page.getByLabel("Filter by workspace").selectOption("company-archived");
  await expect(page.getByText("Activate this workspace before approving drafts.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Rejected")).toBeVisible();

  // Locale bundles are selected by cookie without changing the route.
  // Revisit the same server-backed PENDING fixture in the user's main locale
  // and one additional locale to catch keys inserted into the wrong namespace.
  await context.addCookies([{ name: "NEXT_LOCALE", value: "es", url: UI }]);
  await page.reload();
  await expect(page.getByText("3 pendientes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprobar y enviar" })).toBeVisible();

  await context.addCookies([{ name: "NEXT_LOCALE", value: "tr", url: UI }]);
  await page.reload();
  await expect(page.getByText("3 beklemede")).toBeVisible();
  await expect(page.getByRole("button", { name: "Onayla ve gönder" })).toBeVisible();
});
