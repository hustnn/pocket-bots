// Reply in a bot's own chat: the bot's words the user answers go out quoted in front of
// the message, and the chat reads them back from its timeline to show the quote.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outgoing } from "../src/server/chats";
import { parseReply, QUOTE_MAX, replyText, trimQuote } from "../src/shared/reply";
import { fakeChats, fakeHost, makeBot } from "./helpers";

describe("a reply's text", () => {
  it("quotes the bot's words as a Markdown block quote in front of the message", () => {
    const text = replyText("Option 2: ship on Friday\n\n- with the docs", "Let's do this one");
    expect(text).toBe("Replying to your earlier message:\n> Option 2: ship on Friday\n>\n> - with the docs\n\nLet's do this one");
    expect(parseReply(text)).toEqual({ quote: "Option 2: ship on Friday\n\n- with the docs", body: "Let's do this one" });
  });

  it("keeps a quote's own block quotes and a message's own lines", () => {
    const text = replyText("> nested\nplain", "line one\n> mine\n\nline three");
    expect(parseReply(text)).toEqual({ quote: "> nested\nplain", body: "line one\n> mine\n\nline three" });
  });

  it("cuts a long quote and drops runs of blank lines", () => {
    expect(trimQuote("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
    const long = trimQuote("x".repeat(QUOTE_MAX + 50));
    expect(long).toHaveLength(QUOTE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("isn't a reply without the header and a quote", () => {
    expect(parseReply("Hello")).toBeNull();
    expect(parseReply("Replying to your earlier message:\nno quote")).toBeNull();
  });
});

describe("sending a reply", () => {
  it("puts the quote in front of the message, before its attachments", () => {
    const message = outgoing({ text: "this one", quote: "Option 2", attachments: [{ type: "text", mimeType: "text/plain", title: "notes", text: "n" }] });
    expect(message.text).toBe('Replying to your earlier message:\n> Option 2\n\nthis one\n\n<attachment name="notes">\nn\n</attachment>');
    expect(outgoing({ text: "plain" }).text).toBe("plain");
    expect(outgoing({ text: "plain", quote: "  " }).text).toBe("plain");
  });

  it("refuses a command as a reply, as the agent takes it as typed", () => {
    expect(() => outgoing({ text: "/compact", quote: "Option 2" })).toThrow("A command can't be a reply");
  });
});

describe("a queued reply", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-reply-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("keeps its quote while it waits and sends it with the message", async () => {
    const { MessageQueue } = await import("../src/server/queue");
    const status = { value: "running" };
    const chats = fakeChats({ "chat-q": { get status() { return status.value; } } as never });
    const host = fakeHost([makeBot()]);
    host.attach(chats);
    const queue = new MessageQueue(host);
    await queue.add("chat-q", { text: "go with it", attachments: [], quote: "Plan B" });
    expect((await queue.list("chat-q")).messages).toMatchObject([{ text: "go with it", quote: "Plan B" }]);
    status.value = "idle";
    await queue.resume("chat-q");
    expect(chats.sent.map((entry) => entry.text)).toEqual(["Replying to your earlier message:\n> Plan B\n\ngo with it"]);
  });
});
