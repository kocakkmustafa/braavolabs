/**
 * Automatic review of a skill bundle. `block` rejects the version; `review` sends it to a
 * human; `info` is shown on the review screen. The patterns aim at what a hostile skill
 * would need — hidden text, instruction overrides, secrecy toward the user, encoded
 * payloads, scripts that reach the network or read secrets — not at proving a skill safe:
 * skills are never executed by the daemon, and a person reviews every first release.
 */
import { frontmatter, type Bundle } from "./bundle";

export type Level = "block" | "review" | "info";
export interface Finding { level: Level; code: string; path: string; detail: string }

const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const OVERRIDE = [
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)/i,
  /disregard (?:all |any )?(?:the )?(?:previous|prior|above|system) (?:instructions|prompt|rules)/i,
  /(?:önceki|yukarıdaki) (?:talimatları|kuralları) (?:yok say|unut|dikkate alma)/i,
  /you are no longer|from now on you (?:are|must)/i,
  /reveal (?:your|the) system prompt|print (?:your|the) system prompt/i,
];
const SECRECY = [/do not (?:tell|inform|show) the user/i, /without (?:telling|informing) the user/i, /kullanıcıya (?:söyleme|gösterme|bahsetme)/i, /keep this (?:secret|hidden) from the user/i];
const BASE64 = /[A-Za-z0-9+/]{200,}={0,2}/;
const NETWORK = /\b(?:curl|wget|nc|ncat)\s|fetch\(|XMLHttpRequest|requests\.(?:get|post|put)|http\.client|urllib\.request|socket\.socket|child_process|subprocess\./;
const SECRETS = /~\/\.ssh|\.ssh\/id_|id_rsa|\.aws\/credentials|\.netrc|\.env\b|keychain|security find-generic-password|\.braavo\/(?:token|keys)|\.config\/gh\/hosts/i;
const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const SUSPICIOUS_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])$|(?:^|\.)(?:pastebin\.com|paste\.ee|ghostbin\.\w+|hastebin\.com|transfer\.sh|ngrok\.io|ngrok-free\.app|trycloudflare\.com|webhook\.site|requestbin\.\w+)$/i;
const SCRIPT_EXT = /\.(?:py|js|ts|sh)$/i;

export function scanBundle(b: Bundle, expectedName: string): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, code: string, path: string, detail: string) => out.push({ level, code, path, detail: detail.slice(0, 200) });
  const skill = b.files.find(f => f.path === "SKILL.md");
  const fm = frontmatter(skill?.content ?? "");
  if (!fm.name) add("block", "frontmatter.name", "SKILL.md", "SKILL.md frontmatter needs `name`");
  else if (fm.name !== expectedName) add("block", "frontmatter.name", "SKILL.md", `frontmatter name "${fm.name}" is not the package name "${expectedName}"`);
  if (!fm.description) add("block", "frontmatter.description", "SKILL.md", "SKILL.md frontmatter needs `description`");
  if ((skill?.content.length ?? 0) > 12_000) add("review", "skill.long", "SKILL.md", "SKILL.md is longer than the 12k characters an agent's prompt keeps");

  for (const f of b.files) {
    if (HIDDEN.test(f.content)) add("review", "hidden-unicode", f.path, "invisible or direction-changing characters");
    for (const re of OVERRIDE) { const m = re.exec(f.content); if (m) { add("review", "instruction-override", f.path, m[0]); break; } }
    for (const re of SECRECY) { const m = re.exec(f.content); if (m) { add("review", "secrecy", f.path, m[0]); break; } }
    if (BASE64.test(f.content)) add("review", "encoded-blob", f.path, "a base64 block of 200+ characters");
    for (const url of f.content.match(URL_RE) ?? []) {
      try { if (SUSPICIOUS_HOST.test(new URL(url).hostname)) { add("review", "suspicious-url", f.path, url); break; } } catch { /* not a URL */ }
    }
    if (SCRIPT_EXT.test(f.path)) {
      add("info", "script", f.path, "scripts are never run by Braavolabs");
      const net = NETWORK.exec(f.content); if (net) add("review", "script-network", f.path, net[0].trim());
    }
    const secret = SECRETS.exec(f.content); if (secret) add("review", "secret-path", f.path, secret[0]);
  }
  const license = b.files.find(f => f.path === "LICENSE")?.content.split("\n")[0]?.trim() || fm.license;
  add("info", "license", license ? "LICENSE" : "SKILL.md", license ? `license: ${license}` : "no license stated");
  return out;
}

export const worst = (findings: Finding[]): Level | null =>
  findings.some(f => f.level === "block") ? "block" : findings.some(f => f.level === "review") ? "review" : null;
