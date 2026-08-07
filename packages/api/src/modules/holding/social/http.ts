/**
 * Sosyal hat HTTP yardımcıları — Python `_base.py`'nin TS karşılığı.
 *
 * Tasarım kuralı: hiçbir yardımcı fırlatmaz; hepsi (status, body, raw)
 * döndürür. Bir platformun patlaması diğerlerini durdurmamalı.
 */

export interface HttpResult {
  status: number;
  data: Record<string, unknown>;
  raw: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export interface FetchOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function request(
  url: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    if (raw) {
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return { status: res.status, data, raw: raw.slice(0, 1000) };
  } catch (err) {
    return { status: 0, data: {}, raw: `ağ hatası: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export function postForm(
  url: string,
  form: Record<string, string | undefined>,
  opts?: FetchOpts,
): Promise<HttpResult> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
  return request(url, { method: "POST", body }, opts);
}

export function postJson(
  url: string,
  json: unknown,
  headers: Record<string, string> = {},
  opts?: FetchOpts,
): Promise<HttpResult> {
  return request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(json),
    },
    opts,
  );
}

export function getJson(
  url: string,
  params: Record<string, string | undefined> = {},
  headers: Record<string, string> = {},
  opts?: FetchOpts,
): Promise<HttpResult> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  const full = qs.toString() ? `${url}?${qs}` : url;
  return request(full, { method: "GET", headers }, opts);
}

/** Meta Graph hata mesajını okunur hale getir. */
export function graphError(result: HttpResult): string {
  const err = result.data.error as Record<string, unknown> | undefined;
  if (err) {
    const parts = [String(err.message ?? ""), `(code=${err.code ?? "?"})`];
    if (err.error_user_msg) parts.push(`kullanıcı-mesajı: ${err.error_user_msg}`);
    return parts.filter((p) => p.trim()).join(" ");
  }
  return result.raw.slice(0, 300);
}

/**
 * Asenkron medya işleme için bekleme döngüsü.
 *
 * IG/Threads container'ı ve TikTok yayını anında hazır olmaz. Erken publish
 * çağrısı "Media ID is not available (9007)" verir — bu 2026-08-07'de canlı
 * yakalandı ve GÖRSELLER için de geçerli çıktı (yalnız video sanılıyordu).
 */
export async function pollUntil(
  check: () => Promise<{ done: boolean; ok: boolean; message: string }>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; message: string }> {
  const timeoutMs = opts.timeoutMs ?? 420_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last = "başlangıç";
  while (Date.now() < deadline) {
    const { done, ok, message } = await check();
    last = message;
    if (done) return { ok, message };
    await sleep(intervalMs);
  }
  return { ok: false, message: `${opts.label ?? "işlem"} zaman aşımı (${timeoutMs}ms) — son durum: ${last}` };
}
