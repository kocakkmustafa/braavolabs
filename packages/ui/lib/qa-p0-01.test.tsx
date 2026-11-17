/** BRA-P0-QA-01 — /runs hata durumu, /approvals karar hataları ve INPUT notu, bozuk /agents bağlantısı, skip-link hedefleri, Sidebar /runs. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { screenHarness } from "./approval-handler-harness";
import { decisionErrorKind, decisionMessageKey } from "./inboxActions";
import { classifySurfacePath } from "./surface-domain";
import { ErrorBox, type T } from "../components/inbox/InboxParts";
import ApprovalSheet from "../components/approvals/ApprovalSheet";
import NotFound from "../app/not-found";
import GlobalError from "../app/error";

let mockPath = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k, useLocale: () => "en" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out); else out.push(full);
  }
  return out;
}

describe("(1) /runs liste hatası yutulmaz", () => {
  const src = read("app/runs/page.tsx");
  it("boş catch yok; hata durumu kurulur ve yeniden dene sayacı var", () => {
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    expect(src).toMatch(/\.catch\(\(\) => \{ if \(live\) setLoadFailed\(true\); \}\)/);
    expect(src).toContain("setReloadTick");
  });
  it("hata dalı boş-liste dalından ÖNCE gelir ve başlıkta 'henüz koşu yok' yazmaz", () => {
    expect(src.indexOf("loadFailed ? (")).toBeGreaterThan(-1);
    expect(src.indexOf("loadFailed ? (")).toBeLessThan(src.indexOf("noneInFilter"));
    expect(src).toContain('loadFailed ? "" :');
  });
  it("hata kutusu role=alert + yeniden dene; boş durum metnini taşımaz", () => {
    const html = renderToStaticMarkup(<ErrorBox t={t} title={t("app.inbox.errorTitle")} body={t("app.inbox.errorBody")} onRetry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("app.inbox.retryLoad");
    expect(html).not.toContain("app.runsList.noneInFilter");
    expect(html).not.toContain("app.runsList.noneYet");
  });
});

describe("(2) /approvals eski sayfa: claimFailed, 403/409, INPUT notu", () => {
  let h: ReturnType<typeof screenHarness>;
  beforeEach(async () => { h = screenHarness(resolve(root, "components/approvals/ApprovalsLegacy.tsx"), "web", "queue"); await h.mount(); });

  it("(2a) claimFailed yok sayılmaz: uyarı görünür ve liste sunucudan tazelenir", async () => {
    const before = h.listCalls ?? 0;
    h.response = { success: true, decision: "APPROVED", claimFailed: true, error: "başkası aldı" };
    await h.decide();
    expect(h.text()).toContain("app.approvals.handoffIncomplete");
    expect(h.feedback).not.toContain("success");
    expect(h.listCalls ?? 0).toBeGreaterThan(before);
  });
  it("(2b) 403 yetki mesajı: kart kalır, liste tazelenmez", async () => {
    const before = h.listCalls ?? 0;
    h.reject = { status: 403 };
    await h.decide();
    expect(h.text()).toContain("app.inbox.approvalForbidden");
    expect(h.text()).not.toContain("app.inbox.approvalConflict");
    expect(h.rows()).toHaveLength(1);
    expect(h.listCalls ?? 0).toBe(before);
  });
  it.each([409, 404])("(2b) %i çakışma mesajı ayrı; liste tazelenir", async (status) => {
    const before = h.listCalls ?? 0;
    h.reject = { status };
    await h.decide();
    expect(h.text()).toContain("app.inbox.approvalConflict");
    expect(h.text()).not.toContain("app.inbox.approvalForbidden");
    expect(h.listCalls ?? 0).toBeGreaterThan(before);
  });
  it("(2b) diğer hata genel hata kalır (403/409 mesajı değil)", async () => {
    h.reject = new Error("boom");
    await h.decide();
    expect(h.text()).not.toContain("app.inbox.approvalForbidden");
    expect(h.text()).not.toContain("app.inbox.approvalConflict");
    expect(decisionMessageKey(decisionErrorKind(new Error("x")))).toBe("app.inbox.approvalFailed");
  });
  it("(2c) INPUT onayında not zorunlu ve karar isteğine gider", async () => {
    h.row.type = "INPUT";
    h.render();
    const find = (node: any, pred: (n: any) => boolean): any => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) { for (const c of node) { const f = find(c, pred); if (f) return f; } return undefined; }
      if (pred(node)) return node;
      return find(node.props?.children, pred);
    };
    const approveBtn = () => find(h.tree, (n) => n.type === "button" && JSON.stringify(n.props?.children).includes("app.approvals.approve"));
    const box = find(h.tree, (n) => n.type === "textarea" && n.props?.["data-testid"] === "approval-answer");
    expect(box).toBeTruthy();
    expect(approveBtn().props.disabled).toBe(true);
    box.props.onChange({ target: { value: "  Evet, devam et  " } });
    h.render();
    expect(approveBtn().props.disabled).toBeFalsy();
    await approveBtn().props.onClick();
    const post = h.calls.find((c: any[]) => c[0] === "post");
    expect(post.slice(1)).toEqual([expect.anything(), "synthetic-approval", "APPROVED", "Evet, devam et"]);
  });
  it("(2c) merkez (ApprovalSheet) INPUT için cevap kutusu çizer; diğer türde çizmez", () => {
    const mk = (type: string) => renderToStaticMarkup(
      <ApprovalSheet approval={{ id: "a1", type, description: "d", amountUsd: null, details: { risk: "low", permissions: [], dataTransfer: [], reversible: true } }}
        t={t} legacyT={t as any} locale="en" usd={(n) => `$${n}`} when={null} busy={false} error={null} onDecide={() => {}} onClose={() => {}} />);
    expect(mk("INPUT")).toContain('data-testid="approval-answer"');
    expect(mk("SPEND")).not.toContain('data-testid="approval-answer"');
  });
});

describe("(3) bayrak dışında /agents rotasına bağlantı verilmedi", () => {
  const files = ["app", "components"].flatMap((d) => walkFiles(resolve(root, d)))
    .filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f));
  it("kaynakta '/agents' bağlantısı yok (BRA-UX-05g: rota bayrak arkasında; bayrak KAPALI iken 404 olduğundan bağlantı verilmez)", () => {
    expect(existsSync(resolve(root, "app/agents/page.tsx"))).toBe(true);
    expect(readFileSync(resolve(root, "app/agents/page.tsx"), "utf8")).toMatch(/uxAgentsEnabled\(\)\)\s*notFound\(\)/);
    const hits = files.filter((f) => /["'`]\/agents(?:["'`/?#])/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
  it("components altında id=\"main-content\" ve iç içe <main> yok (AuthLayout tek main-content sahibi)", () => {
    const withId = files.filter((f) => f.includes("/components/") && /id="main-content"/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f));
    expect(withId.filter((f) => !/MainContentTarget/.test(f))).toEqual([]);
    expect(readFileSync(resolve(root, "components/agents/AgentsPage.tsx"), "utf8")).not.toMatch(/<main\b/);
  });
  it("yan menü ve pipeline yerel menüsündeki her href gerçek bir rotaya gider", () => {
    for (const file of ["components/Sidebar.tsx", "app/pipelines/[id]/page.tsx"]) {
      const hrefs = [...read(file).matchAll(/href:\s*"(\/[a-z0-9-]*)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(3);
      for (const href of hrefs) {
        const page = href === "/" ? "app/page.tsx" : `app/${href.slice(1)}/page.tsx`;
        expect(existsSync(resolve(root, page)), `${file} → ${href}`).toBe(true);
      }
    }
  });
});

describe("(4) skip-link hedefi (#main-content) var ve yinelenmez", () => {
  const layout = read("app/AuthLayout.tsx");
  const list = [...(/OWN_MAIN_CONTENT_PATHS = \[([^\]]*)\]/.exec(read("lib/mainContent.ts"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const owns = (route: string) => list.includes(route) || route.startsWith("/docs/") || route.startsWith("/blog/");
  const pages = walkFiles(resolve(root, "app")).filter((f) => f.endsWith("/page.tsx"));
  const routeOf = (f: string) => {
    const r = "/" + relative(resolve(root, "app"), f).replace(/\/?page\.tsx$/, "").replace(/\[[^\]]+\]/g, "x");
    return r === "/" ? "/" : r.replace(/\/$/, "");
  };
  const count = (f: string) => (readFileSync(f, "utf8").match(/id="main-content"/g) ?? []).length;

  it("kabuk, kendi kimliğini taşımayan her sayfa için tek hedef verir (id koşulu ownsMain)", () => {
    expect(layout).toContain('id={ownsMain(pathname) ? undefined : "main-content"}');
    expect(layout).not.toContain('pathname === "/terms" ?');
    expect(list.length).toBeGreaterThan(10);
  });
  it("sayfa kendi kimliğini taşıyorsa kabul listesinde, taşımıyorsa listede değil; hiçbir sayfada ikiden fazla yok", () => {
    for (const f of pages) {
      const route = routeOf(f), n = count(f);
      expect(n, relative(root, f)).toBeLessThanOrEqual(1);
      expect(owns(route), `${route} sayfa kimliği=${n}`).toBe(n === 1);
    }
  });
  it("kabuk ownsMain'i mainContent'ten alır ve dışa aktarır", () => {
    expect(layout).toContain('import { ownsMain } from "../lib/mainContent"');
    expect(layout).toContain("export { ownsMain }");
  });
  it("public yüzeydeki her sayfa kendi hedefini taşır (kabuk sarmalamaz)", () => {
    const publicPages = pages.filter((f) => classifySurfacePath(routeOf(f)) === "public");
    expect(publicPages.length).toBeGreaterThan(15);
    for (const f of publicPages) expect(count(f), relative(root, f)).toBe(1);
  });
});

describe("(5) Sidebar /runs", () => {
  const src = read("components/Sidebar.tsx");
  it("/runs öğesi play_circle ile pipelines'ın hemen ardından; etiket runtime çevirisinden", () => {
    const hrefs = [...src.matchAll(/href: "(\/[a-z-]*)"/g)].map((m) => m[1]);
    expect(hrefs).toContain("/runs");
    expect(hrefs[hrefs.indexOf("/runs") - 1]).toBe("/pipelines");
    expect(src).toMatch(/href: "\/runs", labelKey: "runtime\.mc8f971fe29fd", icon: "play_circle", authOnly: true/);
    const en = JSON.parse(read("messages/en.json"));
    expect(en.runtime.mc8f971fe29fd).toBe("Runs");
  });
});

describe("(4b) 404 ve hata ekranlarında tek skip-link hedefi", () => {
  const ids = (html: string) => (html.match(/id="main-content"/g) ?? []).length;
  const err = new Error("x");
  it.each(["/docs/x", "/blog/x"])("%s: kabuk id vermez, 404 ve hata ekranı tam bir main-content taşır", (path) => {
    mockPath = path;
    expect(ids(renderToStaticMarkup(<NotFound />))).toBe(1);
    expect(ids(renderToStaticMarkup(<GlobalError error={err} reset={() => {}} />))).toBe(1);
  });
  it("/dashboard benzeri yol: kabuk verir, 404 ve hata ekranı id eklemez", () => {
    mockPath = "/dashboard/x";
    expect(ids(renderToStaticMarkup(<NotFound />))).toBe(0);
    expect(ids(renderToStaticMarkup(<GlobalError error={err} reset={() => {}} />))).toBe(0);
  });
});
