// Replying to a bot's message in its own chat (Reply, as groups have it): the message
// goes out with the bot's words it answers quoted in front, as Markdown, so the bot knows which of
// its results the user means, even after its context was compacted. The chat's timeline keeps
// the text as sent, so the quote is read back from it to show above the message.

/** How much of the bot's message a reply quotes; a longer one is cut. */
export const QUOTE_MAX = 2000;

const HEADER = "Replying to your earlier message:";

/** The quote as it goes out: trimmed, without runs of blank lines, at most QUOTE_MAX characters. */
export function trimQuote(quote: string): string {
  const text = quote.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text;
}

/** A message that replies to `quote`: the header, the quote as a Markdown block quote, a blank line, then the message. */
export function replyText(quote: string, text: string): string {
  const lines = trimQuote(quote)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"));
  return `${HEADER}\n${lines.join("\n")}\n\n${text}`;
}

/** A reply's quote and its own words, or null for a message that isn't a reply. */
export function parseReply(text: string): { quote: string; body: string } | null {
  if (!text.startsWith(`${HEADER}\n`)) return null;
  const lines = text.slice(HEADER.length + 1).split("\n");
  let index = 0;
  const quoted: string[] = [];
  while (index < lines.length && lines[index]!.startsWith(">")) quoted.push(lines[index++]!.replace(/^> ?/, ""));
  if (quoted.length === 0) return null;
  if (lines[index] === "") index++;
  return { quote: quoted.join("\n"), body: lines.slice(index).join("\n") };
}
