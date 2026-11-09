import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { approvalsFailed, approvalsLoaded, approvalsRemove, approvalsView, initialApprovalsLoad, startApprovalsLoad } from "./approvalsState";
import { ApprovalsEmpty, ApprovalsLoadError } from "../components/approvals/ApprovalsStatus";

const t = (k: string) => k;
const render = (view: ReturnType<typeof approvalsView>, refreshFailed: boolean) =>
  renderToStaticMarkup(
    <div>
      {view === "error" && <ApprovalsLoadError t={t} onRetry={() => {}} />}
      {refreshFailed && <ApprovalsLoadError t={t} inline onRetry={() => {}} />}
      {view === "empty" && <ApprovalsEmpty t={t} />}
    </div>,
  );
const A = [{ id: "a1" }, { id: "a2" }];

describe("/approvals liste yükleme durumu", () => {
  it("500 -> hata metni + yeniden dene var, 'Her şey temiz' (emptyTitle) YOK", () => {
    const s = approvalsFailed(startApprovalsLoad(initialApprovalsLoad<{ id: string }>()));
    expect(s.status).toBe("error");
    expect(approvalsView(s)).toBe("error");
    const html = render(approvalsView(s), false);
    expect(html).toContain('role="alert"');
    expect(html).toContain("app.approvals.loadErrorTitle");
    expect(html).toContain("app.approvals.retryLoad");
    expect(html).not.toContain("app.approvals.emptyTitle");
  });
  it("200 [] -> 'Her şey temiz' VAR, hata YOK", () => {
    const s = approvalsLoaded<{ id: string }>([]);
    expect(approvalsView(s)).toBe("empty");
    const html = render("empty", s.status === "ready" && s.refreshFailed);
    expect(html).toContain("app.approvals.emptyTitle");
    expect(html).not.toContain('role="alert"');
  });
  it("hata sonrası yeniden dene: yükleniyor -> başarılı liste", () => {
    const err = approvalsFailed(initialApprovalsLoad<{ id: string }>());
    expect(approvalsView(startApprovalsLoad(err))).toBe("loading");
    expect(approvalsView(approvalsLoaded(A))).toBe("list");
  });
  it("önceki liste varken yenileme hatası -> liste korunur + uyarı", () => {
    const s = approvalsFailed(startApprovalsLoad(approvalsLoaded(A)));
    expect(s.status).toBe("ready");
    expect(approvalsView(s)).toBe("list");
    expect(s.status === "ready" && s.data).toEqual(A);
    expect(s.status === "ready" && s.refreshFailed).toBe(true);
    const html = render("list", true);
    expect(html).toContain("app.approvals.refreshErrorTitle");
    expect(html).not.toContain("app.approvals.emptyTitle");
    const again = startApprovalsLoad(s);
    expect(again.status === "ready" && again.refreshFailed).toBe(false);
    expect(approvalsView(again)).toBe("list");
  });
  it("karar sonrası kart düşer; liste boşalırsa boş durum", () => {
    expect(approvalsView(approvalsRemove(approvalsLoaded([{ id: "a1" }]), "a1"))).toBe("empty");
  });
  it("hata durumunda satır silme etkisizdir", () => {
    const e = approvalsFailed(initialApprovalsLoad<{ id: string }>());
    expect(approvalsRemove(e, "x")).toBe(e);
  });
});
