
/** Label on chats started by a routine, carrying the routine id. */
export const ROUTINE_LABEL = "pocket-bots.routine";

/** Older chats were titled "[Bot Name] …"; places grouped by bot show them without the prefix. */
export function displayTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "") || "New chat";
}
