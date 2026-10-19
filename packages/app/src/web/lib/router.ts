import { useSyncExternalStore } from "react";

// Hash routes: #/, #/bot/<id>, #/bot/<id>/chat/<chatId>, #/group/<id>,
// #/library/<tab>, #/settings. A chat or a group can name a message to show
// (a search result): #/bot/<id>/chat/<chatId>/at/<seq>, #/group/<id>/at/<seq>
// and #/group/<id>/thread/<seq>/at/<seq>.

export type Route =
  | { page: "home" }
  | { page: "bot"; botId: string; chatId: string | null; at?: number }
  | { page: "group"; groupId: string; at?: number; thread?: number }
  | { page: "library"; tab: "skills" | "mcp" | "apps" }
  | { page: "settings" };

/** The number after `name` in the route's parts, if there's one. */
function numberAfter(parts: readonly string[], name: string, from: number): number | undefined {
  const index = parts.indexOf(name, from);
  const value = index >= 0 ? Number(parts[index + 1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "bot" && parts[1]) {
    const chatId = parts[2] === "chat" && parts[3] ? parts[3] : null;
    const at = chatId ? numberAfter(parts, "at", 4) : undefined;
    return { page: "bot", botId: parts[1], chatId, ...(at ? { at } : {}) };
  }
  if (parts[0] === "library") return { page: "library", tab: parts[1] === "mcp" || parts[1] === "apps" ? parts[1] : "skills" };
  if (parts[0] === "group" && parts[1]) {
    const at = numberAfter(parts, "at", 2);
    const thread = numberAfter(parts, "thread", 2);
    return { page: "group", groupId: parts[1], ...(at ? { at } : {}), ...(at && thread ? { thread } : {}) };
  }
  if (parts[0] === "settings") return { page: "settings" };
  return { page: "home" };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "bot": {
      if (!route.chatId) return `#/bot/${encodeURIComponent(route.botId)}`;
      return `#/bot/${encodeURIComponent(route.botId)}/chat/${encodeURIComponent(route.chatId)}${route.at ? `/at/${route.at}` : ""}`;
    }
    case "library":
      return `#/library/${route.tab}`;
    case "group":
      return `#/group/${encodeURIComponent(route.groupId)}${route.at ? `${route.thread ? `/thread/${route.thread}` : ""}/at/${route.at}` : ""}`;
    case "settings":
      return "#/settings";
  }
}

export function navigate(route: Route): void {
  const hash = routeHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** Changes the route without a new history entry: a message that was shown leaves the route, so Back skips it. */
export function replaceRoute(route: Route): void {
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (notify) => {
      window.addEventListener("hashchange", notify);
      return () => window.removeEventListener("hashchange", notify);
    },
    () => window.location.hash,
  );
  return parseRoute(hash);
}
