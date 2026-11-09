import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { approvalsAlert, approvalsFailed, approvalsLoaded, approvalsRemove, approvalsView, initialApprovalsLoad, startApprovalsLoad } from "./approvalsState";
import { screenHarness } from "./approval-handler-harness";

type Row = { id: string };
const A: Row[] = [{ id: "a1" }, { id: "a2" }];

describe("approvalsState (saf durum fonksiyonları)", () => {
  it("500 -> hata durumu, asla boş değil", () => {
    const s = approvalsFailed(startApprovalsLoad(initialApprovalsLoad<Row>()));
    expect(s.status).toBe("error");
    expect(approvalsView(s)).toBe("error");
    expect(approvalsAlert(s)).toEqual({ show: true, inline: false, busy: false });
  });
  it("200 [] -> boş durum, uyarı yok", () => {
    const s = approvalsLoaded<Row>([]);
    expect(approvalsView(s)).toBe("empty");
    expect(approvalsAlert(s).show).toBe(false);
  });
  it.each([null, undefined, {}, "x", 0])("başarılı ama dizi olmayan gövde (%j) hatadır, boş değil", (body) => {
    const s = approvalsLoaded<Row>(body, startApprovalsLoad(initialApprovalsLoad<Row>()));
    expect(s.status).toBe("error");
    expect(approvalsView(s)).toBe("error");
  });
  it("dizi olmayan yenileme gövdesi önceki listeyi korur + uyarı", () => {
    const s = approvalsLoaded<Row>({}, approvalsLoaded(A));
    expect(approvalsView(s)).toBe("list");
    expect(s.status === "ready" && s.data).toEqual(A);
    expect(approvalsAlert(s)).toMatchObject({ show: true, inline: true });
  });
  it("hazır ama boş liste + refreshFailed: 'Her şey temiz' değil hata görünümü", () => {
    const s = approvalsFailed(approvalsLoaded<Row>([]));
    expect(approvalsView(s)).toBe("error");
    expect(approvalsAlert(s)).toMatchObject({ show: true, inline: false });
  });
  it("yeniden dene: uyarı yerinde kalır, busy işaretlenir; başarıda kalkar", () => {
    const err = approvalsFailed(initialApprovalsLoad<Row>());
    const retrying = startApprovalsLoad(err);
    expect(approvalsAlert(retrying)).toEqual({ show: true, inline: false, busy: true });
    const ok = approvalsLoaded(A, retrying);
    expect(approvalsView(ok)).toBe("list");
    expect(approvalsAlert(ok).show).toBe(false);
  });
  it("önceki liste varken yenileme hatası -> liste korunur + inline uyarı; retry'da uyarı yerinde busy", () => {
    const s = approvalsFailed(startApprovalsLoad(approvalsLoaded(A)));
    expect(approvalsView(s)).toBe("list");
    expect(s.status === "ready" && s.data).toEqual(A);
    expect(approvalsAlert(s)).toEqual({ show: true, inline: true, busy: false });
    expect(approvalsAlert(startApprovalsLoad(s))).toEqual({ show: true, inline: true, busy: true });
  });
  it("karar sonrası kart düşer; hata durumunda silme etkisizdir", () => {
    expect(approvalsView(approvalsRemove(approvalsLoaded<Row>([{ id: "a1" }]), "a1"))).toBe("empty");
    const e = approvalsFailed(initialApprovalsLoad<Row>());
    expect(approvalsRemove(e, "x")).toBe(e);
  });
});

// Sayfanın GERÇEK kaynağı (harness), listApprovals davranışı sahte.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const mountPage = async (setup: (h: any) => void) => {
  const h: any = screenHarness(resolve(process.cwd(), "app/approvals/page.tsx"), "web", "queue");
  setup(h); await h.mount(); await settle(); h.render();
  return h;
};
const find = (h: any, name: string) => {
  const hit: any[] = [];
  const visit = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n !== "object") return;
    if (typeof n.type === "function" && n.type.name === name) hit.push(n);
    visit(n.props?.children);
  };
  visit(h.tree);
  return hit;
};
const flush = async (h: any) => { await settle(); h.render(); };

describe("/approvals sayfası gerçek yükleme kodu", () => {
  it("listApprovals reddedilirse: hata var, 'Her şey temiz' YOK; retry yeniden istek atar ve listeyi getirir", async () => {
    const h = await mountPage((x) => { x.listError = new Error("500"); });
    expect(find(h, "ApprovalsLoadError")).toHaveLength(1);
    expect(find(h, "ApprovalsEmpty")).toHaveLength(0);
    expect(h.rows()).toHaveLength(0);
    const calls = h.listCalls;
    h.listError = undefined;
    find(h, "ApprovalsLoadError")[0].props.onRetry();
    h.render();
    expect(find(h, "ApprovalsLoadError")[0].props.busy).toBe(true);
    await flush(h);
    expect(h.listCalls).toBe(calls + 1);
    expect(find(h, "ApprovalsLoadError")).toHaveLength(0);
    expect(find(h, "ApprovalsEmpty")).toHaveLength(0);
    expect(h.rows()).toHaveLength(1);
  });
  it("200 [] -> boş durum var, hata yok", async () => {
    const h = await mountPage((x) => { x.listBody = []; });
    expect(find(h, "ApprovalsEmpty")).toHaveLength(1);
    expect(find(h, "ApprovalsLoadError")).toHaveLength(0);
  });
  it("200 + dizi olmayan gövde ({}) -> hata var, boş durum YOK", async () => {
    const h = await mountPage((x) => { x.listBody = {}; });
    expect(find(h, "ApprovalsLoadError")).toHaveLength(1);
    expect(find(h, "ApprovalsEmpty")).toHaveLength(0);
  });
  it("önceki liste varken yenileme hatası -> liste korunur + inline uyarı", async () => {
    const h = await mountPage(() => {});
    expect(h.rows()).toHaveLength(1);
    h.listError = new Error("500");
    // yenileme: sayfanın kendi yükleme fonksiyonu (token/hydrated aynı kaldığı için hata varken retry yok);
    // bu yüzden aynı yükleyiciyi uyarı üzerinden değil, sonraki yenilemeyle tetikleriz.
    h.listQueue = [() => Promise.reject(new Error("500"))];
    h.session.token = "synthetic-token-2"; h.render(); await flush(h);
    expect(h.rows()).toHaveLength(1);
    const alert = find(h, "ApprovalsLoadError");
    expect(alert).toHaveLength(1);
    expect(alert[0].props.inline).toBe(true);
    expect(find(h, "ApprovalsEmpty")).toHaveLength(0);
  });
  it("seq: eski yanıt yeni durumu ezmez", async () => {
    let lateResolve!: (v: unknown) => void;
    const h = await mountPage((x) => { x.listError = new Error("500"); });
    // 1. istek askıda (yeniden dene), 2. istek (token değişimi) önce biter
    h.listError = undefined;
    h.listQueue = [() => new Promise((r) => { lateResolve = r; }), () => Promise.resolve([h.row])];
    find(h, "ApprovalsLoadError")[0].props.onRetry(); h.render();
    h.session.token = "synthetic-token-3"; h.render(); await flush(h);
    expect(h.rows()).toHaveLength(1);
    lateResolve([]); await flush(h);
    expect(h.rows()).toHaveLength(1);
    expect(find(h, "ApprovalsEmpty")).toHaveLength(0);
  });
});
