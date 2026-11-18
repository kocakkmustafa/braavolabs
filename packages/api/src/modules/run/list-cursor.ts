/**
 * BRA-P0-04b — opak liste imleci: createdAt (ISO) + id. Kararlı sıralama
 * createdAt desc, id desc. İstemci biçimi çözmez; bozuk imleç → null (400).
 */
export interface ListCursor { createdAt: Date; id: string }

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): ListCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!o || typeof o.c !== "string" || typeof o.i !== "string" || o.i.length === 0) return null;
    const d = new Date(o.c);
    if (Number.isNaN(d.getTime()) || d.toISOString() !== o.c) return null;
    return { createdAt: d, id: o.i };
  } catch {
    return null;
  }
}

/** createdAt desc, id desc sıralamasında imleçten SONRAKİ satırlar. */
export function afterCursorWhere(c: ListCursor) {
  return { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
}

export const LIST_ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** limit sorgu değeri: yoksa varsayılan; 1..max dışı/sayı değilse null (400). */
export function parseLimit(raw: unknown, dflt: number, max = 100): number | null {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}
