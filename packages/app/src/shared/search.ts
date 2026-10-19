// Search across chats and groups (the command palette and find in chat): what the user
// typed, as the words every result must contain, and the piece of a message a result shows.

/** At most this many words count; the rest of a long query is ignored. */
const MAX_TERMS = 8;

/** The words to find, lowercased and once each: every one must appear, anywhere in a message (any part of a word). */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).map((word) => word.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")).filter(Boolean);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** Whether `text` contains every term (the in-memory check behind a search). */
export function hasAllTerms(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/** About `max` characters of `text` on one line, around its first match. */
export function excerpt(text: string, terms: readonly string[], max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const lower = line.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const first = found.length ? Math.min(...found) : 0;
  const start = first > max / 3 ? first - Math.floor(max / 3) : 0;
  const cut = line.slice(start, start + max).trim();
  return `${start > 0 ? "…" : ""}${cut}${start + max < line.length ? "…" : ""}`;
}

/** `text` split where the terms appear, for marking them. */
export function markTerms(text: string, terms: readonly string[]): { text: string; match: boolean }[] {
  const wanted = terms.filter(Boolean);
  if (wanted.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(`(${[...wanted].sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, match: wanted.includes(part.toLowerCase()) }));
}
