/**
 * Published operator / data-controller record for the legal pages (BRV-21).
 *
 * Source: founder decision 2026-10-24 (publisher record, publisher.json sha256
 * 4404947fbca693a03c9a13ff36e07d3061a1818263f1ab28b48cbdfa2ae6795e; the raw file
 * is not committed). The YULALAB site publishes the same four strings from the
 * same record (src/data/company.ts, REL-03). Render it only through
 * components/LegalOperator so every page shows one identical record.
 */
export const LEGAL_OPERATOR = {
  legalName: "YULA Lab",
  controller: "YULA Lab — Mustafa Kaan Koçak",
  address: "Yeniköy Mahallesi, Bülbül Caddesi No: 50/6, Melikgazi/Kayseri",
  country: "Türkiye",
} as const;
