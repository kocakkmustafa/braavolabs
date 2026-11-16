/**
 * BRA-P1-07-N3 — Pilot paketi dışa aktarma akışı (saf; bağımlılıklar enjekte). Yeni API ucu yok: mevcut
 * `GET /export/:companyId/micro-app` çağrılır (şirketin kendi manifesti + sentetik örnek veri), sonuç istemcide dosya olarak indirilir.
 * Çift tıklamaya karşı kilit çağıran ref'tedir.
 */
import { toPilotPreview, type PilotPreview } from "./preview";

export type PilotErrorKind = "auth" | "forbidden" | "notFound" | "network" | "generic";

/** Şirket kimliğinden güvenli dosya adı: yalnız [a-z0-9-], ilk 8 karakter; yol/kontrol karakteri atılır. */
export function pilotFileName(companyId: string): string {
  const safe = String(companyId ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+/, "").slice(0, 8);
  return `braavolabs-micro-app-${safe || "company"}.json`;
}

export function classifyPilotError(err: unknown): PilotErrorKind {
  if (err instanceof Error && err.name === "SessionChangedError") return "auth";
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : null;
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status !== null) return "generic";
  const message = err instanceof Error ? err.message : "";
  if (/session expired/i.test(message)) return "auth";
  if (err instanceof TypeError || /failed to fetch|network|timed? ?out|abort/i.test(message)) return "network";
  return "generic";
}

export type PilotExportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; preview: PilotPreview }
  | { status: "error"; kind: PilotErrorKind };

export interface PilotExportDeps {
  fileName: string;
  fetchPackage: () => Promise<unknown>;
  download: (fileName: string, json: string) => void;
  setState: (s: PilotExportState) => void;
  lock: { current: boolean };
  /** Bileşen sökülünce true → durum yazılmaz. */
  isCancelled?: () => boolean;
}

/** @returns false: kilit nedeniyle yok sayıldı. */
export async function runPilotExport(d: PilotExportDeps): Promise<boolean> {
  if (d.lock.current) return false;
  d.lock.current = true;
  const set = (s: PilotExportState) => { if (!d.isCancelled?.()) d.setState(s); };
  set({ status: "loading" });
  try {
    const pkg = await d.fetchPackage();
    const preview = toPilotPreview(pkg);
    if (!preview) { set({ status: "error", kind: "generic" }); return true; }
    d.download(d.fileName, JSON.stringify(pkg, null, 2));
    set({ status: "done", preview });
  } catch (err) {
    set({ status: "error", kind: classifyPilotError(err) });
  } finally {
    d.lock.current = false;
  }
  return true;
}

/** Düğme tıklaması: meşgul/kilitli/hazır değilse hiçbir istek başlatmaz. @returns istek başlatıldı mı. */
export function triggerPilotExport(
  c: { hydrated: boolean; token: string | null; companyId: string; busy: boolean } & Omit<PilotExportDeps, "fileName">,
): boolean {
  if (c.busy || c.lock.current || !c.hydrated || !c.token || !c.companyId) return false;
  void runPilotExport({ ...c, fileName: pilotFileName(c.companyId) });
  return true;
}

/** Sonuç/hata göründüğünde odak sonuç bölgesine taşınır. */
export const shouldFocusResult = (status: PilotExportState["status"]): boolean => status === "done" || status === "error";

/** Tarayıcıda JSON'u blob olarak indirir (anchor + object URL); URL sonra serbest bırakılır. */
export function downloadJsonFile(fileName: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
