import danismanlar from "./seed-data/danismanlar.json";
import arsenal from "./seed-data/arsenal.json";

/**
 * Catalog bridge (ENTEGRASYON-KATALOG-VE-VAULT §1-2): the motor cannot RUN
 * a Fable Mental advisor (they are founder-session agents) — it can only
 * RECOMMEND one. These lookups turn an escalation into a routed escalation:
 * "bu iş X danışmanıyla kurucu-oturumu ister" + "arsenal'da şu var".
 * Data = read-only snapshots of holding/registry/capabilities.yaml,
 * refreshed by the kayit-senkronu loop (Mac-side) at seed regeneration.
 */

interface CatalogEntry {
  id?: string;
  name?: string;
  hook: string;
}

function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase("tr")
    .split(/[^a-zçğıöşü0-9]+/i)
    .filter((t) => t.length > 3);
}

function scoreEntry(queryTokens: string[], haystack: string): number {
  const hay = haystack.toLocaleLowerCase("tr");
  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) score += 1;
  }
  return score;
}

/** Best-matching advisor for an escalation context, or null (no guessing). */
export function suggestAdvisor(context: string): { id: string; hook: string } | null {
  const tokens = tokenize(context);
  if (tokens.length === 0) return null;
  let best: { id: string; hook: string } | null = null;
  let bestScore = 1; // eşik: tek zayıf kelime eşleşmesi öneri DOĞURMAZ
  for (const entry of danismanlar as CatalogEntry[]) {
    const id = entry.id ?? entry.name ?? "";
    const score = scoreEntry(tokens, `${id} ${entry.hook}`);
    if (score > bestScore) {
      bestScore = score;
      best = { id, hook: entry.hook };
    }
  }
  return best;
}

/** Top arsenal repo hits for "önce-katalog" enrichment (max 3). */
export function arsenalHits(context: string): Array<{ name: string; hook: string }> {
  const tokens = tokenize(context);
  if (tokens.length === 0) return [];
  return (arsenal as CatalogEntry[])
    .map((entry) => ({
      name: entry.name ?? entry.id ?? "",
      hook: entry.hook,
      score: scoreEntry(tokens, `${entry.name ?? ""} ${entry.hook}`),
    }))
    .filter((e) => e.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ name, hook }) => ({ name, hook }));
}
