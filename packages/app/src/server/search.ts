import { BOT_LABEL, POCKET_LABEL } from "../shared/bot";
import { GROUP_LABEL } from "../shared/group-chat";
import { parseReply } from "../shared/reply";
import type { SearchHit } from "../shared/rpc";
import { excerpt, hasAllTerms, searchTerms } from "../shared/search";
import type { GroupChats } from "./groups";
import type { PocketHost } from "./host";

// Search across conversations (the command palette, and find in a chat): the user's
// and the bots' messages in one-to-one chats (chat timelines) and in groups (group messages),
// from their full-text indexes. A group seat's side isn't searched: the group is.

/** A group message a search found. */
export interface GroupSearchHit {
  groupId: string;
  seq: number;
  thread: number | null;
  from: { kind: "user" } | { kind: "bot"; botId: string; name: string };
  text: string;
  at: string;
}

/**
 * The full-text part of a search's WHERE, for a trigram FTS5 table: one MATCH for the terms of
 * three or more characters (each a quoted substring, all required), and a plain check for the
 * shorter ones, which a trigram index can't look up.
 */
export function ftsFilter(terms: readonly string[], table: string, column: string): { where: string[]; params: string[] } {
  const long = terms.filter((term) => [...term].length >= 3);
  const where: string[] = [];
  const params: string[] = [];
  if (long.length) {
    where.push(`${table} MATCH ?`);
    params.push(long.map((term) => `"${term.replace(/"/g, '""')}"`).join(" "));
  }
  for (const term of terms.filter((entry) => [...entry].length < 3)) {
    where.push(`instr(lower(${column}), ?) > 0`);
    params.push(term);
  }
  return { where, params };
}

/** What a result shows of a message: a reply's own words when they match, without the quote in front. */
function shown(text: string, terms: readonly string[]): string {
  const reply = parseReply(text);
  return excerpt(reply && hasAllTerms(reply.body, terms) ? reply.body : text, terms);
}

/**
 * Messages with every word of `query`, newest first: everywhere, in one chat (`chatId`) or in one
 * group (`groupId`). Chats of bots that were deleted are left out.
 */
export async function searchMessages(host: PocketHost, groups: GroupChats, input: { query: string; chatId?: string; groupId?: string; limit?: number }): Promise<SearchHit[]> {
  const terms = searchTerms(input.query);
  if (terms.length === 0) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 40, 200));
  const bots = new Set((await host.bots()).map((bot) => bot.id));
  const hits: SearchHit[] = [];
  if (!input.groupId) {
    const scope = input.chatId ? { chatId: input.chatId } : { labels: { [POCKET_LABEL]: "1" }, withoutLabels: [GROUP_LABEL] };
    const chats = new Map<string, ReturnType<PocketHost["chats"]["get"]>>();
    for (const hit of host.chats.search(terms, { ...scope, limit })) {
      if (!chats.has(hit.chatId)) chats.set(hit.chatId, host.chats.get(hit.chatId));
      const chat = chats.get(hit.chatId);
      const botId = chat?.labels[BOT_LABEL];
      if (!chat || !botId || !bots.has(botId)) continue;
      hits.push({ kind: "chat", botId, chatId: chat.id, chatTitle: chat.title?.trim() ?? "", archived: !!chat.archivedAt, seq: hit.seq, from: hit.role === "assistant" ? "bot" : "user", text: shown(hit.text, terms), at: hit.at });
    }
  }
  if (!input.chatId) {
    for (const hit of groups.searchAll(terms, { ...(input.groupId ? { groupId: input.groupId } : {}), limit })) {
      hits.push({ kind: "group", groupId: hit.groupId, seq: hit.seq, thread: hit.thread, from: hit.from, text: shown(hit.text, terms), at: hit.at });
    }
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
