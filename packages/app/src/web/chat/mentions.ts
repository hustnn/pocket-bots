import { mentionSpans, type Member } from "../../shared/group-chat";

// The group composer's @mentions: what's being typed after an "@", the bots
// (and @everyone) it could mean, and putting the chosen name in.

export interface MentionQuery {
  /** Where the "@" is. */
  start: number;
  /** What's typed after it, up to the caret. */
  query: string;
}

/** Characters an @mention can follow: the start, a space, an opening bracket or punctuation (CJK included). */
const BEFORE = /[\s([{"'“‘（【「，。、,.;:!?！？；：]/;

/** The @mention being typed at the caret, or null. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && !BEFORE.test(before[start - 1]!)) return null;
  const query = before.slice(start + 1);
  // Names can have a space; a line break, or more than a name's length, ends it.
  if (query.includes("\n") || query.length > 40 || /\s{2}/.test(query)) return null;
  return { start, query };
}

/** The candidates whose name, or a word of it, starts with the query (any case); names that start with it come first. */
export function mentionCandidates<T extends { name: string }>(candidates: readonly T[], query: string): T[] {
  const wanted = query.toLowerCase();
  const starts = candidates.filter((candidate) => candidate.name.toLowerCase().startsWith(wanted));
  const words = candidates.filter((candidate) => !starts.includes(candidate) && candidate.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(wanted)));
  return [...starts, ...words];
}

/** Replaces the typed @query with "@Name " and puts the caret after it. */
export function insertMention(text: string, at: MentionQuery, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: `${text.slice(0, at.start)}${inserted}${after}`, caret: at.start + inserted.length };
}

/** Splits text into plain runs and the @mentions the server wakes bots by, for highlighting. */
export function mentionRuns(text: string, members: readonly Member[]): { text: string; mention: boolean }[] {
  const runs: { text: string; mention: boolean }[] = [];
  let from = 0;
  for (const span of mentionSpans(text, members).spans) {
    if (span.start > from) runs.push({ text: text.slice(from, span.start), mention: false });
    runs.push({ text: text.slice(span.start, span.end), mention: true });
    from = span.end;
  }
  if (from < text.length) runs.push({ text: text.slice(from), mention: false });
  return runs;
}
