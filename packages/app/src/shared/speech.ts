// Turning a reply into what's read aloud.

/** Browsers cut long utterances short, so readings go out in pieces of about this many characters. */
const CHUNK_CHARS = 220;

/** A reply's markdown as plain text to read: code blocks, pictures and link targets are left out. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~|#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentence ends: ". " and the like, or Chinese and Japanese full stops, which need no space after them. */
const SENTENCE_END = /(?<=[.!?])\s+|(?<=[。！？；])\s*/;
/** Inside a sentence too long to read in one go: after its commas and colons. */
const CLAUSE_END = /(?<=[,;:，、；：])\s*/;

/** A sentence in pieces no longer than the chunk size: at its clauses, or by length as a last resort. */
function sentencePieces(sentence: string): string[] {
  if (sentence.length <= CHUNK_CHARS) return [sentence];
  return sentence.split(CLAUSE_END).flatMap((clause) => {
    const pieces: string[] = [];
    for (let at = 0; at < clause.length; at += CHUNK_CHARS) pieces.push(clause.slice(at, at + CHUNK_CHARS));
    return pieces;
  });
}

/** The pieces a reply is read in: whole sentences (or clauses of very long ones), joined up to the chunk size. */
export function speechChunks(markdown: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of speakableText(markdown).split(SENTENCE_END).filter(Boolean).flatMap(sentencePieces)) {
    if (current && current.length + sentence.length + 1 > CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Voices grouped by language for a picker: the reader's own languages first,
 * in their order, then the rest by name. `languageName` labels a language code.
 */
export function voiceGroups<V extends { name: string; lang: string }>(voices: readonly V[], preferred: readonly string[], languageName: (code: string) => string): { label: string; voices: V[] }[] {
  const code = (lang: string) => lang.split(/[-_]/)[0]!.toLowerCase();
  const groups = new Map<string, V[]>();
  for (const voice of voices) groups.set(code(voice.lang), [...(groups.get(code(voice.lang)) ?? []), voice]);
  const wanted = [...new Set(preferred.map(code))];
  const rank = (key: string) => (wanted.includes(key) ? wanted.indexOf(key) : wanted.length);
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: languageName(key), voices: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label))
    .map(({ label, voices: grouped }) => ({ label, voices: grouped }));
}
