import { z } from "zod";

// A group's shared board: the other way bots work together in a group, besides talking in it
// (docs/group-chats.md, "共享看板"). It follows ScaleMAS (arXiv:2610.16120): bots never message
// each other; each publishes what it did to an append-only board of linked entries and reads the
// others' work by searching it. A read returns at most BOARD_SEARCH_K entries, ranked by relevance
// plus a citation weight that rises when later entries build on an entry and decays as the board
// grows, so what a bot takes in doesn't grow with the group. Publishing wakes nobody.
// This file is the board's pure logic: limits, the ranking, the admission rules, and the text the
// bots see. The rounds (who works on a request, who answers it) live in server/groups.ts.

/** The label on a seat's chat naming how its group worked when the seat started: its prompt and tools are for that. */
export const GROUP_COORDINATION_LABEL = "pocket-bots.group.coordination";

/** How a group's bots work together: talking in the group (free, or with a leader), or through the board. */
export const CoordinationSchema = z.enum(["chat", "board"]);
export type Coordination = z.infer<typeof CoordinationSchema>;

/** Entries one search returns at most (the paper's k). */
export const BOARD_SEARCH_K = 8;
/** Entries one visit fetches at most. */
export const BOARD_VISIT_MAX = 8;
/** Refs one entry carries at most. */
export const BOARD_REFS_MAX = 16;
/** Later entries citing an entry that are shown with it, newest first. */
export const BOARD_CITERS_SHOWN = 8;
export const BOARD_SUBTASK_MAX = 300;
export const BOARD_ARTIFACT_MAX = 2_000;
export const BOARD_RATIONALE_MAX = 600;
export const BOARD_CLAIM_MAX = 120;
/** Entries a group's board holds; past that a publish is refused, never an old entry evicted. */
export const BOARD_ENTRIES_MAX = 5_000;
/** A citation moves the cited entry's weight this fraction of the way to 1 (the paper's α). */
export const BOARD_CITE_STEP = 0.3;
/** Every published entry decays every weight by this factor (the paper's γ, per step of the board). */
export const BOARD_DECAY = 0.98;

export const BoardEntrySchema = z.object({
  /** B1, B2…: numbered per group, never reused. */
  number: z.number(),
  authorId: z.string(),
  /** The request it was published during, when its author was working on one. */
  round: z.number().nullable(),
  subTask: z.string(),
  artifact: z.string(),
  rationale: z.string(),
  /** "B3" (an earlier entry) and "#12" (a group message). */
  refs: z.array(z.string()),
  /** The piece of work it takes on, which no other entry for the same request can take (normalized). */
  claim: z.string().nullable(),
  createdAt: z.string(),
});
export type BoardEntry = z.infer<typeof BoardEntrySchema>;

/** A board entry as the web UI shows it: with its author and weight, which bots never see. */
export const BoardEntryViewSchema = BoardEntrySchema.extend({ author: z.string(), weight: z.number(), citedBy: z.array(z.number()) });
export type BoardEntryView = z.infer<typeof BoardEntryViewSchema>;

// ---------------------------------------------------------------- refs

export type BoardRef = { kind: "entry"; number: number } | { kind: "message"; seq: number };

/** "B3" or "#12"; null for anything else. */
export function parseBoardRef(ref: string): BoardRef | null {
  const entry = /^B([1-9]\d*)$/.exec(ref);
  if (entry) return { kind: "entry", number: Number(entry[1]) };
  const message = /^#([1-9]\d*)$/.exec(ref);
  if (message) return { kind: "message", seq: Number(message[1]) };
  return null;
}

/** Whether a rationale names a ref as a token of its own: B1 isn't named by B12, nor #1 by #12. */
export function namesRef(rationale: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(rationale);
}

/**
 * Why an entry can't be published, or null: the paper's two rules (every ref exists, and the
 * rationale names every ref) plus the bounds. `exists` answers for one ref; an entry ref must be
 * earlier than the entry, which any existing entry is.
 */
export function boardEntryProblem(input: { subTask: string; artifact: string; rationale: string; refs: readonly string[]; claim?: string | null }, exists: (ref: BoardRef) => boolean): string | null {
  if (!input.subTask.trim() || !input.artifact.trim() || !input.rationale.trim()) return "sub_task, artifact and rationale are all required.";
  if (input.subTask.length > BOARD_SUBTASK_MAX) return `sub_task is ${input.subTask.length} characters; keep it within ${BOARD_SUBTASK_MAX}.`;
  if (input.artifact.length > BOARD_ARTIFACT_MAX) return `artifact is ${input.artifact.length} characters; keep it within ${BOARD_ARTIFACT_MAX}: publish a long result as several entries, or put it in a file and give the path.`;
  if (input.rationale.length > BOARD_RATIONALE_MAX) return `rationale is ${input.rationale.length} characters; keep it within ${BOARD_RATIONALE_MAX}.`;
  if (input.claim !== undefined && input.claim !== null && (!claimKey(input.claim) || input.claim.length > BOARD_CLAIM_MAX)) return `claim names the piece you take on in a few words (at most ${BOARD_CLAIM_MAX} characters), such as a file or a part of the request.`;
  if (input.refs.length > BOARD_REFS_MAX) return `${input.refs.length} refs; an entry carries at most ${BOARD_REFS_MAX}.`;
  if (new Set(input.refs).size !== input.refs.length) return "A ref is listed twice.";
  for (const ref of input.refs) {
    const parsed = parseBoardRef(ref);
    if (!parsed) return `${ref} isn't a ref: refs are board entries (B3) and group messages (#12).`;
    if (!exists(parsed)) return `${ref} doesn't exist: cite only entries and messages you have seen.`;
  }
  for (const ref of input.refs) if (!namesRef(input.rationale, ref)) return `The rationale doesn't name ${ref}: say what each ref contributed (e.g. "${ref} gave the list").`;
  return null;
}

/**
 * A claim as the board keeps it, so "src/Slugify.ts " and "src/slugify.ts" are the same piece: NFKC,
 * lower case, inner whitespace collapsed. Claims are first come, first served within a request
 * (the slot ownership of Park et al., arXiv:2609.21032), so two bots joining at once can't take the
 * same piece.
 */
export function claimKey(claim: string): string {
  return claim.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

const PATH = /[\p{L}\p{N}_-]+(?:[./][\p{L}\p{N}_-]+)+/gu;
const words = (key: string) => new Set(key.split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * Whether two claims (claimKey) take the same piece, however differently they're written: the same
 * key; a file in common ("src/duration.js" and "duration.js (parse + format)"); or every word of one
 * in the other ("src/wrap.js" and "src/wrap.js and test/wrap.test.js"). Bots name a piece in their
 * own words, so equal keys alone let two of them take it.
 */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const files = (key: string) => new Set((key.match(PATH) ?? []).flatMap((path) => [path, path.split("/").at(-1)!]));
  const fa = files(a);
  if ([...files(b)].some((file) => fa.has(file))) return true;
  const [wa, wb] = [words(a), words(b)];
  const within = (x: Set<string>, y: Set<string>) => x.size > 0 && [...x].every((word) => y.has(word));
  return within(wa, wb) || within(wb, wa);
}

// ---------------------------------------------------------------- ranking

const CJK_RUN = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u;

/**
 * NFKC, lower case, runs of letters and digits, with CJK split from Latin letters and digits written
 * against it ("缓存TTL为5分钟" is 缓存, ttl, 为, 5, 分钟). A CJK run, having no spaces between
 * words, becomes its character pairs (a lone character stays as it is), so a query matches part of
 * a phrase or a compound (长江 in 长江大桥) without a dictionary. On a labeled Chinese set this beat
 * jieba word segmentation, which misses words inside its dictionary's compounds (docs/group-board.md).
 */
export function boardTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    for (const [index, part] of word.split(CJK_RUN).entries()) {
      if (!part) continue;
      // split() with a capture group puts the CJK runs at the odd indexes.
      if (index % 2 === 0) {
        tokens.push(part);
        continue;
      }
      const chars = [...part];
      if (chars.length === 1) tokens.push(part);
      for (let i = 1; i < chars.length; i++) tokens.push(chars[i - 1]! + chars[i]!);
    }
  }
  return tokens;
}

/** BM25 (k1 1.5, b 0.75) of each entry's three fields against the query; only entries that match. */
export function boardRelevance(entries: readonly BoardEntry[], query: string): Map<number, number> {
  const terms = [...new Set(boardTokens(query))];
  const docs = entries.map((entry) => ({ number: entry.number, tokens: boardTokens(`${entry.subTask} ${entry.artifact} ${entry.rationale}`) }));
  const scores = new Map<number, number>();
  if (!terms.length || !docs.length) return scores;
  const average = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const idf = new Map(terms.map((term) => {
    const df = docs.filter((doc) => doc.tokens.includes(term)).length;
    return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tokens.filter((token) => token === term).length;
      if (tf) score += (idf.get(term)! * tf * 2.5) / (tf + 1.5 * (0.25 + (0.75 * doc.tokens.length) / average));
    }
    if (score > 0) scores.set(doc.number, score);
  }
  return scores;
}

/**
 * Each entry's citation weight now, replayed from the board itself: each later entry that cites an
 * entry moves its weight BOARD_CITE_STEP of the way to 1, and each entry published decays every
 * weight by BOARD_DECAY. A function of the entries alone, so nothing is stored or drifts.
 */
export function citationWeights(entries: readonly BoardEntry[]): Map<number, number> {
  const sorted = [...entries].sort((a, b) => a.number - b.number);
  const weight = new Map<number, { value: number; at: number }>();
  for (const entry of sorted) {
    for (const ref of new Set(entry.refs)) {
      const parsed = parseBoardRef(ref);
      if (parsed?.kind !== "entry" || parsed.number >= entry.number) continue;
      const before = weight.get(parsed.number);
      const decayed = before ? before.value * BOARD_DECAY ** (entry.number - before.at) : 0;
      weight.set(parsed.number, { value: decayed + BOARD_CITE_STEP * (1 - decayed), at: entry.number });
    }
  }
  const now = sorted.at(-1)?.number ?? 0;
  return new Map([...weight].map(([number, { value, at }]) => [number, value * BOARD_DECAY ** (now - at)]));
}

/**
 * The entries matching a query, best first: weight plus relevance scaled to [0, 1]. Only entries the
 * query matches are ranked, so weight reorders relevant entries and never brings in an unrelated
 * one; ties go to the earlier entry.
 */
export function rankBoard(entries: readonly BoardEntry[], query: string): BoardEntry[] {
  const relevance = boardRelevance(entries, query);
  const max = Math.max(0, ...relevance.values());
  if (max <= 0) return [];
  const weights = citationWeights(entries);
  const score = (entry: BoardEntry) => (weights.get(entry.number) ?? 0) + relevance.get(entry.number)! / max;
  return entries.filter((entry) => relevance.has(entry.number)).sort((a, b) => score(b) - score(a) || a.number - b.number);
}

/** Who cites each entry, newest first. */
export function citersOf(entries: readonly BoardEntry[]): Map<number, number[]> {
  const citers = new Map<number, number[]>();
  for (const entry of [...entries].sort((a, b) => b.number - a.number)) {
    for (const ref of new Set(entry.refs)) {
      const parsed = parseBoardRef(ref);
      if (parsed?.kind === "entry") citers.set(parsed.number, [...(citers.get(parsed.number) ?? []), entry.number]);
    }
  }
  return citers;
}

// ---------------------------------------------------------------- what bots read

/** An entry as a bot reads it: its fields and links, never its author or weight. */
export function boardEntryText(entry: BoardEntry, citedBy: readonly number[] = []): string {
  const links = [entry.refs.length ? `Refs: ${entry.refs.join(", ")}` : "", citedBy.length ? `Cited by: ${citedBy.slice(0, BOARD_CITERS_SHOWN).map((number) => `B${number}`).join(", ")}${citedBy.length > BOARD_CITERS_SHOWN ? ` (+${citedBy.length - BOARD_CITERS_SHOWN} earlier)` : ""}` : ""].filter(Boolean);
  return [`B${entry.number} — ${entry.subTask.trim()}`, ...(entry.claim ? [`Takes: ${entry.claim}`] : []), `Artifact: ${entry.artifact.trim()}`, `Rationale: ${entry.rationale.trim()}`, ...(links.length ? [links.join(" · ")] : [])].join("\n");
}

export function boardSearchText(query: string, ranked: readonly BoardEntry[], total: number, citers: ReadonlyMap<number, number[]>): string {
  if (!total) return "The board is empty: nothing has been published yet.";
  if (!ranked.length) return `No entry matches "${query}" among the board's ${total}. Try other words (the names of files, functions or subjects), or this work hasn't been recorded yet.`;
  const shown = ranked.slice(0, BOARD_SEARCH_K);
  return [`${ranked.length} of the board's ${total} entries match "${query}"; the ${shown.length === 1 ? "best" : `best ${shown.length}`}:`, "", ...shown.map((entry) => `${boardEntryText(entry, citers.get(entry.number))}\n`)].join("\n").trimEnd();
}

// ---------------------------------------------------------------- the seat's prompt and notices

/**
 * The prompt section for a seat in a board group: how the bots work together, in ScaleMAS's four
 * rules (read before you write, publish intermediate work as you go, write to be found, cite what
 * you used), Park et al.'s claims and verified progress (a piece is claimed before it's worked on;
 * results carry their evidence, and a wrong one is corrected in the open), and how a request goes
 * round and who answers it.
 */
export function boardSection(subAgents: boolean): string {
  return [
    "How this group works: through a shared board, not by talking to each other.",
    "- The user's requests go to the bots, which work on them in parallel and never message each other: the board is how your work reaches the other bots, and theirs reaches you. Nobody assigns work; what each bot takes on comes from the board. Your group messages reach only the user.",
    "- An open request goes to one bot first, which does it alone unless it has several substantial pieces that can run in parallel: every bot that joins starts from nothing and reads the context again, so splitting small work costs more than it saves. To split, it publishes the plan and claims its own piece, which brings the other bots in. Split by the inputs (files, documents, sections), so each piece reads its own part, not by the kind of check, which has every bot read everything.",
    "- READ BEFORE YOU WRITE: before starting a piece, board_search its wording and the names of what you'd work on (files, functions, subjects). Work an entry records is DONE: build on it and take uncovered ground.",
    "- CLAIM, THEN WORK: when you join a request, your first entry claims a piece (board_publish with claim: the piece's name as the plan gives it, such as a file you'll change or a set of documents; never the whole request); nothing else is accepted from you until you have. The first claim wins: a piece that overlaps one already claimed for the request is refused, so pick another. A piece whose bot's turn failed is released for someone else to take.",
    "- STAY IN YOUR CLAIM: do your piece, not the others'. Don't redo or re-verify a piece whose entry gives its evidence, and leave files another bot claimed alone; if you doubt an entry, check that one thing and publish what you found.",
    "- Publish as you go, mostly intermediate work: partial results, leads, dead ends, what you ruled out. Work you don't publish is lost to the others.",
    '- An entry (board_publish): sub_task, what you did in the present perfect, in the words someone would search for ("I\'ve checked the retry limits in api.md"); artifact, the result itself, reusable without redoing the work, with how you checked it (the test or command and its outcome; label unchecked claims as such); rationale, briefly how you got it, naming every ref and what it gave ("B3 listed the files"); refs, the entries (B3) and group messages (#12) you used. A ref must exist and the rationale must name it, or the entry is refused. Cite what you used. Build on a result whose evidence holds; when you find an entry wrong, publish that, citing it.',
    "- board_search returns at most 8 entries, ranked by relevance and by how much others built on them, never by who wrote them. board_visit fetches entries by number, such as an entry's refs or the entries citing it.",
    "- When your part of a request is done, publish its result and call board_finish with the request's number: the last bot to finish answers the user, and board_finish tells you whether that's you. The answer is a group_send with reply_to: the request, built from the board, not only your part: the outcome first, what was done and found, what was checked, and what's left open; if the request has an overall check (a test suite, a build), the one answering runs it once. Otherwise stop: don't post progress or results in the group.",
    ...(subAgents ? ["- Do your pieces yourself: the other bots already work in parallel, and a sub-agent starts from nothing and can't use the board."] : []),
  ].join("\n");
}

/** One request a seat is woken for, and its part in it. */
export type RoundNotice =
  | { kind: "first"; seq: number; waiting: number }
  | { kind: "join"; seq: number; starter: string | null; others: readonly string[]; position: number; joining: number; taken: readonly string[] }
  | { kind: "together"; seq: number; others: readonly string[] }
  | { kind: "solo"; seq: number }
  | { kind: "report"; seq: number; orphaned: readonly string[] };

/** What a seat's notice says about a request it's woken for. */
export function roundNoticeText(notice: RoundNotice): string {
  const seq = notice.seq;
  const finish = `Call board_finish with request: ${seq} when your part is done; the last bot to finish answers the user.`;
  switch (notice.kind) {
    case "first":
      return `You're first on #${seq}; ${notice.waiting} other bot${notice.waiting === 1 ? " is" : "s are"} waiting. If you'll do it alone, do it and answer (group_send with reply_to: ${seq}), without claiming anything: answering is all it takes, and the others are never woken. Split it only when it has several substantial pieces that can run in parallel: publish the plan with its pieces, split by its inputs (files, documents, sections), then claim yours; your claim brings the others in. ${finish}`;
    case "join": {
      const started = notice.starter ? `${notice.starter} started on #${seq}, and you` : "You";
      const company = notice.others.length ? ` join it with ${notice.others.join(", ")}` : " join it";
      const taken = notice.taken.length ? ` Claimed so far: ${notice.taken.join("; ")}.` : "";
      return `${started}${company}: you're ${notice.position} of ${notice.joining} joining now.${taken} Search the board for the plan (board_search), then make your first entry a claim on a piece nobody has claimed (when several are free, try number ${notice.position} of them first); do only that piece and publish as you go. ${finish}`;
    }
    case "together":
      return `The user asked you and ${notice.others.join(", ")} on #${seq}: work on it together through the board (board_search first, then publish as you go). ${finish}`;
    case "solo":
      return `The user asked you (#${seq}): do it and answer with group_send, reply_to: ${seq}.`;
    case "report":
      return `Everyone working on #${seq} has finished and nobody has answered it: answer the user now, with group_send reply_to: ${seq}. Build the answer from the board (board_search it): the outcome first, what was done and found, what was checked, and what's left open.${orphanedText(notice.orphaned)}`;
  }
}

/** The pieces claimed by bots whose turn failed and that nobody claimed again, for the one answering. */
function orphanedText(orphaned: readonly string[]): string {
  return orphaned.length ? ` A bot whose turn failed had claimed these pieces, now released: ${orphaned.join("; ")}. Check the board for what it got done; do what's missing if you can (claim it first), or say in the answer that it's left open.` : "";
}

/** What board_finish tells a bot. */
export function finishText(input: { seq: number } & ({ state: "not_working" } | { state: "others"; working: readonly string[] } | { state: "last"; orphaned?: readonly string[] } | { state: "answered"; answer: number } | { state: "claim_first"; taken: readonly string[] })): string {
  const seq = input.seq;
  switch (input.state) {
    case "not_working":
      return `You aren't working on #${seq}: nothing to finish.`;
    case "others":
      return `Noted: your part of #${seq} is done. Still working: ${input.working.join(", ")}. The last one to finish answers the user, so stop here.`;
    case "last":
      return `You're the last on #${seq}: answer the user now, with group_send reply_to: ${seq}. Build it from the board (board_search it: the others' work isn't in your context); if the request has an overall check (a test suite, a build), run it once first. The outcome first, then what was done and found, what was checked, and what's left open.${orphanedText(input.orphaned ?? [])}`;
    case "answered":
      return `#${seq} was answered in #${input.answer} before you finished. If your part changes or adds to that answer, reply to #${input.answer} with just that; otherwise stop here.`;
    case "claim_first":
      return `Not published: you joined #${seq}, so your first entry must claim a piece (board_publish with claim). Claimed so far: ${input.taken.length ? input.taken.join("; ") : "nothing"}. Claim a piece nobody has, or, if every piece is taken, call board_finish.`;
  }
}
