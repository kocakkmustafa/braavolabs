/**
 * BRA-UX-05h-b — "Tekrar dene" sonrası odak. Hata kutusu (ve içindeki düğme) yeniden denemeyle DOM'dan kalkar; odak `body`ye
 * düşmesin diye tıklanınca sonuç alanına taşınır. Sonuç gelince (hazır) odak orada kalır; yine hata dönerse yeni "Tekrar dene"
 * düğmesine gider. Beklerken (yükleniyor/boşta) bir şey yapılmaz.
 */
export type RetryFocusTarget = "results" | "retry" | null;

export function retryFocusTarget(pending: boolean, status: "idle" | "loading" | "ready" | "error"): RetryFocusTarget {
  if (!pending) return null;
  if (status === "ready") return "results";
  if (status === "error") return "retry";
  return null;
}
