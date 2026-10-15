import type { SystemEvent } from "./contract.js";

/** Render a SystemEvent as the `[system] …` steering line agents see in tool results. */
export function renderSystemEvent(event: SystemEvent): string {
  switch (event.type) {
    case "popup_opened":
      return `[system] popup opened from tab ${event.openerTabId}: tab ${event.tab.tabId} ${event.tab.url} (now owned by this session)`;
    case "tab_closed":
      return event.activeTabId === undefined
        ? `[system] tab ${event.tabId} closed (${event.reason}). No active tab: open or select one before acting.`
        : `[system] tab ${event.tabId} closed (${event.reason}). Active tab is now ${event.activeTabId}.`;
    case "download_started":
      return `[system] download started: ${event.download.url}`;
    case "download_finished":
      return `[system] download ${event.download.state}: ${event.download.path}`;
    case "dialog":
      return `[system] ${event.dialogType} dialog ${event.action}: ${JSON.stringify(event.message)}`;
    case "navigation":
      return `[system] ${event.kind === "spa" ? "route changed" : "navigated"} to ${event.url}`;
    case "lease_revoked":
      return `[system] user took tab ${event.tabId} back (${event.reason}); do not act on it.`;
    case "orphans_closed":
      return `[system] closed ${event.tabIds.length} orphaned agent tab(s) from a crashed session.`;
    case "tab_limit_warning":
      return `[system] ${event.openTabs} agent tabs open — close tabs you no longer need.`;
  }
}

export function renderSystemEvents(events: readonly SystemEvent[]): string {
  return events.map(renderSystemEvent).join("\n");
}
