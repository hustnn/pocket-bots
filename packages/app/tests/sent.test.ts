import { describe, expect, it } from "vitest";
import { rememberSent, sentAttachments } from "../src/web/lib/sent";

describe("sent attachments", () => {
  const file = { kind: "text" as const, id: "t1", name: "notes.md", size: 5, text: "hello" };

  it("finds a message's attachments by its id, then by its text", () => {
    rememberSent("m-1", "  look at this ", [file]);
    expect(sentAttachments({ text: "look at this", messageId: "m-1" })).toEqual([file]);
    expect(sentAttachments({ text: "look at this", clientMessageId: "other" })).toEqual([file]);
    expect(sentAttachments({ text: "something else" })).toEqual([]);
  });

  it("matches a message sent with attachments alone by the line sent for it", () => {
    rememberSent("m-2", "", [file]);
    expect(sentAttachments({ text: "See the attached files." })).toEqual([file]);
  });

  it("ignores messages without attachments", () => {
    rememberSent("m-3", "plain", []);
    expect(sentAttachments({ text: "plain", messageId: "m-3" })).toEqual([]);
  });
});
