// Marks the words a search found in what's on screen, as the browser's own find does, with the
// CSS Custom Highlight API: no change to the page's elements, so React's rendering is untouched.
// Browsers without the API just don't mark them.

const NAME = "pocket-find";

/** The words the last search result was picked for, and the place it opens (see `placeKey`), so that place can mark them. */
let pending: { place: string; terms: string[] } | null = null;

/** A search result's place: a chat's or a group's message. */
export const placeKey = (kind: "chat" | "group", id: string, seq: number) => `${kind}:${id}:${seq}`;

export function setPendingTerms(place: string, terms: readonly string[]): void {
  pending = { place, terms: [...terms] };
}

/** The words a result was picked for, when `place` is where it opened (the same array each time). */
export function pendingTermsFor(place: string): string[] {
  return pending?.place === place ? pending.terms : [];
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };

function registry(): HighlightRegistry | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : null;
}

/** Where messages' own words are, in a chat or a group (not names, times or buttons). */
const MESSAGE_TEXT = ".bubble, .msg-assistant, .reply-quote-text";

/** Marks every place the terms appear in the messages inside `root` (replacing the last marks); no terms clears them. */
export function markTermsIn(root: Element | null, terms: readonly string[]): void {
  const highlights = registry();
  if (!highlights) return;
  const wanted = terms.map((term) => term.toLowerCase()).filter(Boolean);
  if (!root || wanted.length === 0) {
    highlights.delete(NAME);
    return;
  }
  const ranges: Range[] = [];
  for (const element of root.querySelectorAll(MESSAGE_TEXT)) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.toLowerCase() ?? "";
      for (const term of wanted) {
        for (let index = text.indexOf(term); index >= 0 && ranges.length < 2000; index = text.indexOf(term, index + term.length)) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + term.length);
          ranges.push(range);
        }
      }
    }
  }
  const Highlight = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  highlights.set(NAME, new Highlight(...ranges));
}
