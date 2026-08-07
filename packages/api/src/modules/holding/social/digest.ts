/**
 * Günlük özet — kurucunun istediği "anlamlı olaylar + günlük özet"in ikinci yarısı.
 *
 * Özet BELLEKTEN değil, `post_log` ve `post_queue`'dan TÜRETİLİR. Neden:
 * bellekte biriken bir sayaç sunucu yeniden başladığında sıfırlanır ve
 * "bugün 6 yayın" diyen özet aslında 9 yayını anlatıyor olur. Kayıt zaten
 * veritabanında — ikinci bir gerçek kaynağı yaratmak ikisinin ayrışması demek.
 */

import { socialSupabase } from "./config";
import { qTime, type QueueDeps } from "./queue";
import type { SocialBrand, SocialPlatform } from "./types";

export interface DigestRow {
  brand: SocialBrand;
  platform: SocialPlatform;
  status: string;
  platform_url: string | null;
  error_message: string | null;
  posted_at: string;
}

export interface BrandDigest {
  brand: SocialBrand;
  published: DigestRow[];
  failed: DigestRow[];
  pendingApproval: number;
}

function headers(): Record<string, string> {
  const { serviceKey } = socialSupabase();
  return { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
}

/** Verilen günün (UTC) yayın kayıtlarını marka bazında topla. */
export async function collectDailyDigest(
  day: Date,
  deps: QueueDeps = {},
): Promise<BrandDigest[]> {
  const { url } = socialSupabase();
  const doFetch = deps.fetchImpl ?? fetch;
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 3600_000);

  const logRes = await doFetch(
    `${url}/rest/v1/post_log?posted_at=gte.${qTime(start)}&posted_at=lt.${qTime(end)}&select=*`,
    { headers: headers() },
  );
  const rows: DigestRow[] = logRes.ok ? ((await logRes.json()) as DigestRow[]) : [];

  const pendingRes = await doFetch(
    `${url}/rest/v1/post_queue?approval_status=eq.pending&select=brand`,
    { headers: headers() },
  );
  const pending: Array<{ brand: SocialBrand }> = pendingRes.ok
    ? ((await pendingRes.json()) as Array<{ brand: SocialBrand }>)
    : [];

  const byBrand = new Map<SocialBrand, BrandDigest>();
  const ensure = (brand: SocialBrand): BrandDigest => {
    if (!byBrand.has(brand)) {
      byBrand.set(brand, { brand, published: [], failed: [], pendingApproval: 0 });
    }
    return byBrand.get(brand)!;
  };

  for (const r of rows) {
    const d = ensure(r.brand);
    if (r.status === "published") d.published.push(r);
    else d.failed.push(r);
  }
  for (const p of pending) ensure(p.brand).pendingApproval += 1;

  return [...byBrand.values()];
}

/** Bir markanın günlük özetini Slack metnine çevir. */
export function renderBrandDigest(digest: BrandDigest, day: string): string {
  const lines: string[] = [`*${day} — ${digest.brand} günlük yayın özeti*`];
  lines.push(`• ✅ Yayınlanan: ${digest.published.length} · ❌ Başarısız: ${digest.failed.length}`);
  if (digest.pendingApproval > 0) {
    lines.push(`• ⏳ Onay bekleyen: ${digest.pendingApproval}`);
  }
  if (digest.published.length) {
    lines.push("");
    for (const p of digest.published.slice(0, 12)) {
      lines.push(`  · ${p.platform}${p.platform_url ? ` — <${p.platform_url}|bak>` : ""}`);
    }
  }
  if (digest.failed.length) {
    lines.push("");
    lines.push("*İlgi bekleyenler:*");
    for (const f of digest.failed.slice(0, 8)) {
      lines.push(`  · ${f.platform}: ${(f.error_message ?? "").slice(0, 160)}`);
    }
  }
  if (!digest.published.length && !digest.failed.length && !digest.pendingApproval) {
    lines.push("_Bugün yayın hareketi yok._");
  }
  return lines.join("\n");
}
