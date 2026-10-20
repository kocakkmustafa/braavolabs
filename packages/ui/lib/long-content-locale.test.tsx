import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DOCS, localizeDoc } from "../app/docs/content";
import { POSTS, localizePost } from "../app/blog/posts";
import KvkkPage from "../app/kvkk/page";
import GdprPage from "../app/gdpr/page";
import { locales } from "../i18n/locales";

const context = vi.hoisted(() => ({ locale: "en" }));
const messages = (locale: string) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => context.locale, useTranslations: (namespace?: string) => actual.createTranslator({
    locale: context.locale, namespace, messages: messages(context.locale), onError: error => { throw error; },
  }) };
});
const contentCopy = (locale: string) => ({ raw: (key: string) => key.split(".").reduce((value: any, part) => value?.[part], messages(locale).content) });

describe("actual long-content bindings", () => {
  it.each(locales)("localizes all eight docs and seven posts without changing code/route identity in %s", locale => {
    const copy = contentCopy(locale);
    for (const source of DOCS) {
      const doc = localizeDoc(source, copy);
      expect(doc.title).toBe(copy.raw(`docs.${source.slug}.title`));
      expect([doc.slug, doc.order, doc.category, doc.icon]).toEqual([source.slug, source.order, source.category, source.icon]);
      expect(doc.blocks.map(block => block.kind)).toEqual(source.blocks.map(block => block.kind));
      source.blocks.forEach((block, index) => {
        if (block.kind === "code") {
          expect(doc.blocks[index]).toMatchObject({ kind: "code", code: block.code, lang: block.lang });
        }
        if (block.kind === "heading") expect(doc.blocks[index]).toMatchObject({ id: block.id });
      });
    }
    for (const source of POSTS) {
      const post = localizePost(source, copy, locale);
      expect(post.slug).toBe(source.slug); expect(post.category).toBe(source.category);
      expect(post.body).toBe(copy.raw(`blog.${source.slug}.body`));
      expect(post.date).toBe(new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "medium" }).format(new Date(source.date)));
      expect(post.read).toBe(new Intl.NumberFormat(locale, { style: "unit", unit: "minute" }).format(Number.parseInt(source.read, 10)));
    }
  });
  it("rejects a missing prose cell without discarding or translating technical code", () => {
    expect(() => localizeDoc(DOCS[0], { raw: () => undefined })).toThrow("Invalid content message");
  });
  it.each(locales)("renders the explicit legal preview and stable anchors in %s", locale => {
    context.locale = locale;
    const catalog = messages(locale), notice = catalog.surface.legal.previewNotice;
    for (const Page of [KvkkPage, GdprPage]) {
      const html = renderToStaticMarkup(<Page />);
      // React escapes human text; compare its exact native text-node serialization.
      const escaped = renderToStaticMarkup(<span>{notice}</span>).slice(6, -7);
      expect(html).toContain(escaped); expect(html).not.toContain("surface.legal.");
      for (const [, language] of html.matchAll(/\blang="([^"]+)"/g)) expect(language).toBe(locale);
    }
    const kvkk = renderToStaticMarkup(<KvkkPage />), gdpr = renderToStaticMarkup(<GdprPage />);
    expect(kvkk).toContain('id="veri-sorumlusu"'); expect(kvkk).toContain('id="saklama-suresi"');
    expect(gdpr).toContain('id="cross-border-transfers"'); expect(gdpr).toContain('id="retention"');
  });
});
