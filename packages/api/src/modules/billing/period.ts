/**
 * BRA-P0-03e-b: `releaseQuota` her zaman GEÇERLİ UTC ayının sayacını düşer. Claim ile iade farklı
 * aylardaysa iade yanlış ayı eksiltirdi; çağıranlar bu yardımcıyla ay sınırında iadeyi atlar.
 */
export const sameUtcMonth = (a: Date | number, b: Date | number): boolean => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth();
};
