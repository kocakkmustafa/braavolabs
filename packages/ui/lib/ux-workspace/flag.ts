/**
 * BRA-UX-05b — Birleşik çalışma alanı bayrağı. `/runs/[id]` yalnız `NEXT_PUBLIC_UX_WORKSPACE=1|true` iken yeni iş sayfasını
 * (kip morfu: Özet → Çıktı → Kaput) sunar; varsayılan KAPALI ve kapalıyken sayfa `RunDetailLegacy` (BU BİLETTEN ÖNCEKİ ekran) olarak
 * birebir sunulur. Bayrak SUNUCUDA, istek anında okunur (`process.env` nesnesi bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…`
 * erişimi derleme anında gömülür). `?view=classic` bayrak açıkken de eski ayrıntı sayfasını verir (yeniden çalıştırma/geri alma/ısı haritası orada).
 */
export const UX_WORKSPACE_ENV = "NEXT_PUBLIC_UX_WORKSPACE";

export function uxWorkspaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_WORKSPACE_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Bayrak açık VE `?view=classic` yok → yeni iş sayfası. */
export function showWorkspace(enabled: boolean, view: string | string[] | undefined): boolean {
  const v = Array.isArray(view) ? view[0] : view;
  return enabled && v !== "classic";
}
