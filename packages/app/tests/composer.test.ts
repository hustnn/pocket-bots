import { describe, expect, it } from "vitest";
import {
  activeTurnBehaviorFor,
  applyCommand,
  commandQuery,
  contextUsage,
  draftKey,
  filterCommands,
  formatCost,
  formatTokenCount,
  meterTone,
  parseDrafts,
  parseSendBehavior,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  restoreFailedSend,
  sendLabel,
  serializeDrafts,
  withOwnCommands,
} from "../src/web/chat/composer";

describe("send behavior", () => {
  it("reads the setting, defaulting to steer", () => {
    expect(parseSendBehavior("queue")).toBe("queue");
    expect(parseSendBehavior("interrupt")).toBe("interrupt");
    expect(parseSendBehavior("nonsense")).toBe("steer");
    expect(parseSendBehavior(undefined)).toBe("steer");
  });

  it("never queues behind a pending permission", () => {
    expect(resolveActiveSendBehavior("queue", true)).toBe("interrupt");
    expect(resolveActiveSendBehavior("queue", false)).toBe("queue");
    expect(resolveActiveSendBehavior("steer", true)).toBe("steer");
  });

  it("maps the behavior to what a mid-turn message does", () => {
    expect(activeTurnBehaviorFor("steer")).toBe("steer");
    expect(activeTurnBehaviorFor("interrupt")).toBe("interrupt");
    expect(activeTurnBehaviorFor("queue")).toBe("interrupt");
  });

  it("resolves Enter and Cmd/Ctrl+Enter", () => {
    expect(resolveDefaultAction({ behavior: "queue", running: true, canQueue: true })).toBe("queue");
    expect(resolveDefaultAction({ behavior: "queue", running: false, canQueue: true })).toBe("send");
    expect(resolveDefaultAction({ behavior: "queue", running: true, canQueue: false })).toBe("send");
    expect(resolveDefaultAction({ behavior: "steer", running: true, canQueue: true })).toBe("send");
    expect(resolveAlternateAction({ behavior: "steer", running: true, canQueue: true })).toBe("queue");
    expect(resolveAlternateAction({ behavior: "queue", running: true, canQueue: true })).toBe("send");
    expect(resolveAlternateAction({ behavior: "steer", running: false, canQueue: true })).toBeNull();
  });

  it("labels the send button with what it will do", () => {
    expect(sendLabel({ action: "send", behavior: "steer", running: false })).toBe("Send");
    expect(sendLabel({ action: "send", behavior: "steer", running: true })).toBe("Steer");
    expect(sendLabel({ action: "send", behavior: "interrupt", running: true })).toBe("Interrupt");
    expect(sendLabel({ action: "queue", behavior: "queue", running: true })).toBe("Queue");
  });
});

describe("context window meter", () => {
  it("reads usage only when the numbers are valid", () => {
    expect(contextUsage({ contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 50_000, totalCostUsd: 0.42 })).toEqual({ percent: 25, used: 50_000, max: 200_000, costUsd: 0.42 });
    expect(contextUsage({ contextWindowMaxTokens: 0, contextWindowUsedTokens: 10 })).toBeNull();
    expect(contextUsage({ contextWindowUsedTokens: 10 })).toBeNull();
    expect(contextUsage(null)).toBeNull();
  });

  it("uses the meter's thresholds and formats tokens and cost", () => {
    expect(meterTone(50)).toBe("normal");
    expect(meterTone(70)).toBe("warning");
    expect(meterTone(91)).toBe("danger");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(45_300)).toBe("45k");
    expect(formatTokenCount(1_200_000)).toBe("1m");
    expect(formatCost(0)).toBeNull();
    expect(formatCost(0.004)).toBe("$0.0040");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

describe("slash commands", () => {
  const learn = { name: "learn", description: "Save it as a skill", argumentHint: "" };
  const provider = [
    { name: "compact", description: "", argumentHint: "" },
    { name: "learn", description: "the provider's own", argumentHint: "" },
    { name: "clear", description: "", argumentHint: "" },
    { name: "review-pr", description: "", argumentHint: "" },
  ];

  it("only opens for a lone /word", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/Com")).toBe("com");
    expect(commandQuery("/compact now")).toBeNull();
    expect(commandQuery("hi /compact")).toBeNull();
  });

  it("keeps pocket-bots's command over a provider's with the same name and ranks prefix matches first", () => {
    const merged = withOwnCommands([learn], provider);
    expect(merged.filter((command) => command.name === "learn")).toEqual([learn]);
    expect(filterCommands(merged, "c").map((command) => command.name)).toEqual(["clear", "compact"]);
    expect(filterCommands(merged, "r").map((command) => command.name)).toEqual(["review-pr", "clear", "learn"]);
    expect(applyCommand(learn)).toBe("/learn ");
  });

  it("keeps the app's own commands first and hides provider internals", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ name: `a${String(index).padStart(2, "0")}`, description: "", argumentHint: "" }));
    const merged = withOwnCommands([learn], [{ name: "__internal", description: "", argumentHint: "" }, ...many]);
    const shown = filterCommands(merged, "", { pinned: ["learn"] }).map((command) => command.name);
    expect(shown[0]).toBe("learn");
    expect(shown).toHaveLength(50);
    expect(shown).not.toContain("__internal");
    expect(filterCommands(merged, "r", { pinned: ["learn"] }).map((command) => command.name)).toEqual(["learn"]);
  });
});

describe("drafts", () => {
  const image = (id: string, bytes: number) => ({ kind: "image" as const, id, name: `${id}.png`, mimeType: "image/png", size: bytes, data: "x".repeat(bytes) });

  it("keys a draft per chat, and one per bot for its new chat", () => {
    expect(draftKey("bot-1", "chat-1")).toBe("chat:chat-1");
    expect(draftKey("bot-1", null)).toBe("new:bot-1");
  });

  it("round-trips drafts and drops malformed or empty ones", () => {
    const raw = JSON.stringify({
      a: { text: "hello", attachments: [{ kind: "text", id: "t", name: "n.md", size: 1, text: "x" }, { kind: "image", id: "bad" }], updatedAt: 3 },
      b: { text: "", attachments: [] },
      c: "nonsense",
    });
    expect(parseDrafts(raw)).toEqual({ a: { text: "hello", attachments: [{ kind: "text", id: "t", name: "n.md", size: 1, text: "x" }], updatedAt: 3 } });
    expect(parseDrafts("not json")).toEqual({});
  });

  it("keeps the newest drafts and sheds the oldest images past the size budget", () => {
    const drafts = {
      old: { text: "old", attachments: [image("i1", 600)], updatedAt: 1 },
      mid: { text: "", attachments: [image("i2", 600)], updatedAt: 2 },
      new: { text: "new", attachments: [image("i3", 600)], updatedAt: 3 },
    };
    const kept = parseDrafts(serializeDrafts(drafts, { maxBytes: 1_500 }));
    expect(kept.new!.attachments).toHaveLength(1);
    expect(kept.old).toMatchObject({ text: "old", attachments: [] });
    // A draft that was only an image goes once its image does.
    expect(kept.mid).toBeUndefined();
    expect(Object.keys(parseDrafts(serializeDrafts(drafts, { maxDrafts: 1 })))).toEqual(["new"]);
  });

  it("puts a failed send back ahead of what was typed meanwhile", () => {
    const failed = { text: "first", attachments: [image("a", 1)] };
    expect(restoreFailedSend(failed, { text: "", attachments: [] })).toEqual(failed);
    expect(restoreFailedSend(failed, { text: "more", attachments: [image("b", 1)] })).toEqual({ text: "first\nmore", attachments: [image("a", 1), image("b", 1)] });
  });
});
