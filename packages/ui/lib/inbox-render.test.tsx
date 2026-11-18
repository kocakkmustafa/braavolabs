import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { BucketTabs, RunRow, ReceiptPanel, ErrorBox, ApprovalGroups, type T } from "../components/inbox/InboxParts";
import { INBOX_TABS } from "./inbox";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
const t: T = (key, v) => v ? `${key}${JSON.stringify(v)}` : key;
const run = { id: "r1", pipelineId: "p", status: "PAUSED", state: "PAUSED" as const, resultStatus: null, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", bucket: "stuck" as const, costUsd: 1.5, pipeline: { id: "p", name: "Weekly report", company: { id: "c", name: "Acme" } } };
const noop = () => {};

describe("inbox markup", () => {
  it("sekmeler tablist/tab rolleri ve roving tabindex taşır", () => {
    const html = renderToStaticMarkup(<BucketTabs tabs={INBOX_TABS} active="done" onChange={noop} t={t} />);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toMatch(/id="inbox-tab-done"[^>]*aria-selected="true"[^>]*tabindex="0"|aria-selected="true"[^>]*tabindex="0"/);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
  });
  it("duraklatılmış koşuda yalnız izinli eylemler görünür", () => {
    const html = renderToStaticMarkup(<RunRow run={run} t={t} locale="en" busy={false} message={null} receipt={null} steerOpen={false} onAction={noop} onSteerToggle={noop} onSteerSend={async () => true} onReceiptToggle={noop} />);
    for (const a of ["resume", "retry", "steer", "stop", "receipt"]) expect(html).toContain(`app.inbox.action.${a}`);
    expect(html).not.toContain("app.inbox.action.pause");
  });
  it("hata kutusu role=alert ve yeniden dene düğmesi gösterir (boş durum değil)", () => {
    const html = renderToStaticMarkup(<ErrorBox t={t} title="E" body="B" onRetry={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("app.inbox.retryLoad");
  });
  it("receipt VERIFIED / UNVERIFIED / yok / hata", () => {
    const base = { id: "x", runId: "r1", tenantId: "t", outcome: "COMPLETED" as const, costUsd: 0.2, evidence: [{ kind: "test" as const, ref: "tool_call:1", ok: true }], approvalIds: [], contentHash: "h", createdAt: "2026-11-01T10:00:00Z" };
    const ver = renderToStaticMarkup(<ReceiptPanel t={t} locale="en" state={{ status: "ready", receipt: { ...base, resultStatus: "VERIFIED" } }} />);
    expect(ver).toContain("app.inbox.receipt.verified");
    expect(ver).not.toContain("app.inbox.receipt.unverified");
    const un = renderToStaticMarkup(<ReceiptPanel t={t} locale="en" state={{ status: "ready", receipt: { ...base, resultStatus: "UNVERIFIED", evidence: [] } }} />);
    expect(un).toContain("app.inbox.receipt.unverified");
    expect(un).toContain("app.inbox.receipt.noEvidence");
    expect(renderToStaticMarkup(<ReceiptPanel t={t} locale="en" state={{ status: "none" }} />)).toContain("app.inbox.receipt.none");
    expect(renderToStaticMarkup(<ReceiptPanel t={t} locale="en" state={{ status: "error" }} />)).toContain('role="alert"');
  });
  it("onay ayrıntısı (açıklama, tutar, koşu bağlantısı) gizlenmez", () => {
    const g = [{ runId: "r1", runTitle: "Weekly report", approvals: [{ id: "a1", runId: "r1", status: "PENDING", description: "Spend on ads", amountUsd: 42, createdAt: "2026-11-01T10:00:00Z" }] }];
    const html = renderToStaticMarkup(<ApprovalGroups groups={g} busyIds={new Set()} errorByApproval={{}} onDecide={noop} t={t} locale="en" />);
    expect(html).toContain("Spend on ads");
    expect(html).toContain("$42");
    expect(html).toContain('href="/runs/r1"');
  });
});
