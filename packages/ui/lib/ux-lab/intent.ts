/**
 * BRA-UX-04 — Niyet Çubuğu sınıflayıcı ÖNİZLEMESİ (04-design.md §5.1). Yerel, kural tabanlı ve ÖRNEKTİR:
 * "niyet sınıflayıcı" API'si yok (§14 önkoşul b). Sunucudaki `POST /jobs/plan` kendi `intent` kararını verir
 * ve plan adımında üstün gelir; bu yalnız kullanıcıya "Anladığım: …" ipucu gösterir ve değiştirilebilir.
 * Kural (§5.1): güven düşükse varsayılan SOHBET; iş planına yalnız yüksek güven ya da kullanıcı "İş" seçerse gidilir.
 */
export type IntentKind = "chat" | "job" | "agent";
export const INTENT_KINDS: readonly IntentKind[] = ["chat", "job", "agent"];
export interface IntentGuess { kind: IntentKind; confidence: "high" | "low" }

/** `\b` yalnız ASCII'dir (ö/ç/ş/ı kenarda çalışmaz): Unicode harf sınırı kullanılır. */
const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");

const AGENT_NOUN = words(["ajan", "ajanı", "ajanlar", "agent", "agents", "iş arkadaşı", "asistan"]);
const CREATE_VERB = words(["oluştur", "yarat", "ekle", "kur", "hazırla", "create", "add", "build", "make", "new"]);
const JOB_VERB = words([
  "özetle", "özet çıkar", "hazırla", "gönder", "kaydet", "çıkar", "raporla", "tara", "listele", "yaz", "derle", "analiz et", "planla", "düzenle",
  "summari[sz]e", "draft", "send", "prepare", "generate", "extract", "compile", "schedule", "write", "analy[sz]e", "report",
]);
const QUESTION = /[?？]\s*$/u;
const QUESTION_WORD = words(["neden", "nasıl", "ne", "kim", "kaç", "hangi", "why", "how", "what", "who", "when", "which"]);

export function classifyIntent(raw: string): IntentGuess {
  const text = raw.trim();
  if (!text) return { kind: "chat", confidence: "low" };
  const count = text.split(/\s+/u).length;
  if (AGENT_NOUN.test(text) && CREATE_VERB.test(text) && count >= 3) return { kind: "agent", confidence: "high" };
  if (QUESTION.test(text) || (QUESTION_WORD.test(text.split(/\s+/u)[0] ?? "") && !JOB_VERB.test(text))) return { kind: "chat", confidence: "high" };
  if (JOB_VERB.test(text) && count >= 4) return { kind: "job", confidence: "high" };
  return { kind: "chat", confidence: "low" };
}

/** Kullanıcının seçimi (varsa) sınıflayıcıyı ezer; tahmin yalnız ipucudur. */
export function effectiveIntent(guess: IntentGuess, override: IntentKind | null): IntentKind {
  return override ?? guess.kind;
}

/** Enter/Gönder bu niyeti hangi akışa götürür (§5.1: sohbet seçiliyken plana DÜŞMEZ). */
export function flowForIntent(kind: IntentKind): "chat" | "plan" | "agent" {
  return kind === "job" ? "plan" : kind;
}
