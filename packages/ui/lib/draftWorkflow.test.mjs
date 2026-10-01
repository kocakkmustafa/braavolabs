import assert from "node:assert/strict";
import test from "node:test";
import { draftActions, previewDraftContent } from "./draftWorkflow.ts";

test("only a selected tenant's active pending draft offers approval and actual email send", () => {
  const company = { id: "company-1", status: "ACTIVE" };
  assert.deepEqual(draftActions({ companyId: "company-1", status: "PENDING", type: "EMAIL" }, company), {
    approve: true, send: true, reject: true,
  });
  assert.deepEqual(draftActions({ companyId: "company-1", status: "PENDING", type: "SOCIAL_POST" }, company), {
    approve: true, send: false, reject: true,
  });
  assert.deepEqual(draftActions({ companyId: "other-tenant-company", status: "PENDING", type: "EMAIL" }, company), {
    approve: false, send: false, reject: false,
  });
});

test("inactive companies and terminal drafts never offer approval or send", () => {
  for (const status of ["DRAFT", "PAUSED", "ARCHIVED"]) {
    assert.deepEqual(draftActions(
      { companyId: "company-1", status: "PENDING", type: "EMAIL" },
      { id: "company-1", status },
    ), { approve: false, send: false, reject: true });
  }
  for (const status of ["APPROVED", "PUBLISHED", "REJECTED", "ARCHIVED"]) {
    assert.deepEqual(draftActions(
      { companyId: "company-1", status, type: "EMAIL" },
      { id: "company-1", status: "ACTIVE" },
    ), { approve: false, send: false, reject: false });
  }
  assert.deepEqual(draftActions(null, { id: "company-1", status: "ACTIVE" }), {
    approve: false, send: false, reject: false,
  });
});

test("preview displays authored body and hashtags without recipient or metadata", () => {
  assert.equal(previewDraftContent({
    to: "private@example.com", subject: "Internal subject", body: " Hello ",
    hashtags: ["one", "#two", 42, ""], metadata: { secret: "private" },
  }), "Hello\n\n#one #two");
  assert.equal(previewDraftContent({ text: "Social copy" }), "Social copy");
  assert.equal(previewDraftContent("Plain content"), "Plain content");
});

test("malformed content has no JSON fallback or private-field leak", () => {
  for (const value of [null, [], 42, { to: "private@example.com" }, { body: { secret: "private" } }, { body: "  " }]) {
    assert.equal(previewDraftContent(value), null);
  }
});
