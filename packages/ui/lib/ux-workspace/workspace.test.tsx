import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("../api", () => ({ api: { getRun: vi.fn(), listHandoffs: vi.fn(), runReceipt: vi.fn() } }));

import JobDrawer from "../../components/inbox/JobDrawer";
import JobModes from "../../components/job/JobModes";
import type { T } from "../../components/inbox/InboxParts";
import type { InboxRun } from "../inbox";
import { UX_WORKSPACE_ENV, showWorkspace, uxWorkspaceEnabled } from "./flag";
import { toJobRun } from "./run";

const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);
const noop = () => {};
const run = (over: Partial<InboxRun> = {}): InboxRun => ({
  id: "r1", pipelineId: "p", status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0.42, createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z", bucket: null,
  pipeline: { id: "p", name: "Rapor", company: { id: "c", name: "Atölye" } }, ...over,
});
const modes = (r: InboxRun, extra?: React.ReactNode) => renderToStaticMarkup(
  <JobModes run={r} token="tok" t={t} locale="tr" rtl={false} busy={false} message={null} onAction={noop} onSteer={async () => true} extraLinks={extra} />,
);

describe("bayrak (NEXT_PUBLIC_UX_WORKSPACE)", () => {
  it("varsayılan KAPALI; yalnız 1/true (büyük-küçük harf ve boşluktan bağımsız) açar", () => {
    expect(UX_WORKSPACE_ENV).toBe("NEXT_PUBLIC_UX_WORKSPACE");
    expect(uxWorkspaceEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "off", "yes", "2"]) expect(uxWorkspaceEnabled({ NEXT_PUBLIC_UX_WORKSPACE: v })).toBe(false);
    for (const v of ["1", "true", " TRUE ", "True"]) expect(uxWorkspaceEnabled({ NEXT_PUBLIC_UX_WORKSPACE: v })).toBe(true);
  });
  it("showWorkspace: bayrak kapalıyken her zaman eski sayfa; açıkken ?view=classic eski sayfayı verir", () => {
    expect(showWorkspace(false, undefined)).toBe(false);
    expect(showWorkspace(false, "classic")).toBe(false);
    expect(showWorkspace(true, undefined)).toBe(true);
    expect(showWorkspace(true, "other")).toBe(true);
    expect(showWorkspace(true, "classic")).toBe(false);
    expect(showWorkspace(true, ["classic", "x"])).toBe(false);
  });
});

describe("toJobRun (GET /runs/:id → InboxRun)", () => {
  it("var olan alanları eşler; bucket her zaman null (detay ucu kova vermez)", () => {
    const r = toJobRun({
      id: "r1", status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL", resultStatus: "VERIFIED", costUsd: "1.25", pipelineId: "p1",
      createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:05:00Z", pipeline: { id: "p1", name: "Rapor", company: { id: "c1", name: "Atölye" } },
    });
    expect(r).toMatchObject({ id: "r1", status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL", resultStatus: "VERIFIED", costUsd: "1.25", bucket: null, pipelineId: "p1" });
    expect(r?.pipeline?.company).toEqual({ id: "c1", name: "Atölye" });
    expect(r?.updatedAt).toBe("2026-11-11T09:05:00Z");
  });
  it("eksik/bilinmeyen alan uydurulmaz: state null, resultStatus null, şirket null, updatedAt createdAt'e düşer", () => {
    const r = toJobRun({ id: "r2", status: "RUNNING", state: "BOGUS", resultStatus: "MAYBE", startedAt: "2026-11-11T08:00:00Z", pipeline: { name: "X" } });
    expect(r).toMatchObject({ state: null, resultStatus: null, costUsd: null, createdAt: "2026-11-11T08:00:00Z", updatedAt: "2026-11-11T08:00:00Z" });
    expect(r?.pipeline?.company).toBeNull();
  });
  it("kimlik ya da durum yoksa / nesne değilse null", () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { id: "r" }, { status: "RUNNING" }, { id: "", status: "RUNNING" }]) expect(toJobRun(bad)).toBeNull();
  });
});

describe("JobModes (çekmece ve iş sayfası ortak gövdesi)", () => {
  it("üç kip: Özet/Çıktı/Kaput; sohbet kipi YOK ('yakında' dahil)", () => {
    const html = modes(run());
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    for (const id of ["summary", "output", "kaput"]) expect(html).toContain(`app.jobs.tab.${id}`);
    expect(html).not.toMatch(/chat|sohbet|soon|yakında/i);
    expect(html).toMatch(/id="job-tab-summary"[^>]*aria-selected="true"/);
    expect(html).toContain('id="job-tabpanel"');
    expect(html).toContain("job-mode-in"); // 180 ms çapraz solma sınıfı
  });
  it("ek bağlantılar kabuktan gelir (çekmece: tam sayfa, iş sayfası: klasik görünüm)", () => {
    expect(modes(run(), <a href="/runs/r1?view=classic">klasik</a>)).toContain('href="/runs/r1?view=classic"');
    expect(modes(run())).not.toContain("view=classic");
  });
  it("çekmece aynı gövdeyi kullanır: sekmeler ve tam sayfa bağlantısı korunur", () => {
    const html = renderToStaticMarkup(<JobDrawer run={run()} token="tok" t={t} locale="tr" rtl={false} busy={false} message={null} onAction={noop} onSteer={async () => true} onClose={noop} />);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('href="/runs/r1"');
    expect(html).toContain("app.jobs.openFull");
  });
  it("bilinmeyen durumda eylem uydurulmaz: FAILED yalnız yeniden dene", () => {
    const html = modes(run({ status: "FAILED", state: "FAILED" }));
    expect(html).toContain("app.inbox.action.retry");
    for (const a of ["pause", "resume", "stop"]) expect(html).not.toContain(`app.inbox.action.${a}`);
  });
});
