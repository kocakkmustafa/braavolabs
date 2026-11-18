// Settings deep link: `/settings?tab=integrations`. Whitelist only; anything
// else falls back to the default tab.
export function settingsTabFromSearch(search: string, validIds: readonly string[], fallback = "profile"): string {
  const tab = new URLSearchParams(search).get("tab");
  return tab && validIds.includes(tab) ? tab : fallback;
}
