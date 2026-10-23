import type { Metadata } from "next";

/**
 * The root layout's title template appends " | Braavolabs". Localized SEO
 * titles already end with the brand (for example "Pricing — Braavolabs"), so
 * applying the template produced "… — Braavolabs | Braavolabs". Titles that
 * already name the brand are emitted as absolute; others keep the template.
 */
export function brandTitle(title: string): Metadata["title"] {
  return /Braavolabs/.test(title) ? { absolute: title } : title;
}
