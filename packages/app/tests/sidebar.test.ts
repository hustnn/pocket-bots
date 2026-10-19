import { describe, expect, it } from "vitest";
import { pixelAvatar } from "../src/shared/avatar";
import { darkBackground } from "../src/shared/pixel";
import { BotListUiSchema, DEFAULT_BOT_LIST_UI, StoreSchema } from "../src/shared/bot";
import { aggregateBuckets, applyStoredOrdering, chatBucket, chatSettled, chatUnread, moveKey, orderChats, READ_MARKS_KEPT, readMark, withReadMark } from "../src/shared/sidebar";

describe("chatBucket", () => {
  const base = { status: "idle", pendingPermissions: [], requiresAttention: false, attentionReason: null };

  it("puts a pending permission above an error", () => {
    expect(chatBucket({ ...base, status: "error", pendingPermissions: [{}] })).toBe("needs_input");
    expect(chatBucket({ ...base, attentionReason: "permission" })).toBe("needs_input");
  });

  it("maps errors, running and unread replies", () => {
    expect(chatBucket({ ...base, status: "error" })).toBe("failed");
    expect(chatBucket({ ...base, status: "error", requiresAttention: true, attentionReason: "error" })).toBe("failed");
    expect(chatBucket({ ...base, status: "running", requiresAttention: true })).toBe("running");
    expect(chatBucket({ ...base, requiresAttention: true })).toBe("attention");
  });

  it("shows a chat past an earlier failure as unread, not failed", () => {
    // The error attention stays up after later turns go fine.
    const recovered = { ...base, requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-10-01T10:00:00.000Z", lastUserMessageAt: "2026-10-01T11:00:00.000Z" };
    expect(chatBucket(recovered)).toBe("attention");
    expect(chatBucket(recovered, readMark(recovered, "2026-10-01T11:05:00.000Z"))).toBe("done");
  });

  it("does not treat initializing as running", () => {
    expect(chatBucket({ ...base, status: "initializing" })).toBe("done");
  });
});

describe("read state", () => {
  const finished = {
    status: "idle",
    pendingPermissions: [],
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: "2026-10-01T10:00:00.000Z",
    lastUserMessageAt: "2026-10-01T09:59:00.000Z",
  };
  const seen = readMark(finished, "2026-10-01T10:01:00.000Z");

  it("keeps a finished chat unread until it's seen, then shows no dot", () => {
    expect(chatUnread(finished, undefined)).toBe(true);
    expect(chatBucket(finished, undefined)).toBe("attention");
    expect(chatUnread(finished, seen)).toBe(false);
    expect(chatBucket(finished, seen)).toBe("done");
  });

  it("is unread again after a later turn, though the first attention timestamp stays", () => {
    const replied = { ...finished, lastUserMessageAt: "2026-10-01T12:00:00.000Z" };
    expect(chatBucket(replied, seen)).toBe("attention");
  });

  it("is unread again when attention is raised afresh", () => {
    expect(chatBucket({ ...finished, attentionTimestamp: "2026-10-01T13:00:00.000Z" }, seen)).toBe("attention");
  });

  it("needs no mark for a chat without attention", () => {
    expect(chatUnread({ ...finished, requiresAttention: false, attentionReason: null, attentionTimestamp: null }, undefined)).toBe(false);
  });

  it("leaves pending permissions, running and failed chats alone", () => {
    expect(chatBucket({ ...finished, status: "running", pendingPermissions: [{}] }, seen)).toBe("needs_input");
    expect(chatBucket({ ...finished, status: "running" }, seen)).toBe("running");
    expect(chatBucket({ ...finished, status: "error", attentionReason: "error" }, seen)).toBe("failed");
  });

  it("marks only a settled chat as seen", () => {
    expect(chatSettled({ status: "idle", pendingPermissions: [] })).toBe(true);
    expect(chatSettled({ status: "error" })).toBe(true);
    expect(chatSettled({ status: "running" })).toBe(false);
    expect(chatSettled({ status: "initializing" })).toBe(false);
    expect(chatSettled({ status: "idle", pendingPermissions: [{}] })).toBe(false);
  });

  it("keeps the newest marks", () => {
    const at = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    let marks = {};
    for (let index = 0; index < READ_MARKS_KEPT + 5; index++) marks = withReadMark(marks, `chat-${index}`, { message: null, attention: null, at: at(index) });
    expect(Object.keys(marks)).toHaveLength(READ_MARKS_KEPT);
    expect(marks).not.toHaveProperty("chat-4");
    expect(marks).toHaveProperty("chat-5");
    expect(withReadMark(marks, "chat-5", seen)["chat-5"]).toEqual(seen);
  });
});

describe("aggregateBuckets", () => {
  it("keeps the most urgent, with running above attention", () => {
    expect(aggregateBuckets(["attention", "running", "done"])).toBe("running");
    expect(aggregateBuckets(["running", "failed"])).toBe("failed");
    expect(aggregateBuckets(["failed", "needs_input"])).toBe("needs_input");
    expect(aggregateBuckets([])).toBe("done");
  });
});

describe("applyStoredOrdering", () => {
  const key = (item: string) => item;

  it("reorders stored items within their own slots and leaves new ones in place", () => {
    expect(applyStoredOrdering(["new", "a", "b", "c"], ["c", "a", "b"], key)).toEqual(["new", "c", "a", "b"]);
  });

  it("ignores unknown and duplicate keys", () => {
    expect(applyStoredOrdering(["a", "b"], ["x", "b", "b", "a"], key)).toEqual(["b", "a"]);
    expect(applyStoredOrdering(["a", "b"], ["x"], key)).toEqual(["a", "b"]);
  });
});

describe("orderChats", () => {
  const chat = (id: string, createdAt: string, updatedAt: string) => ({ id, createdAt, updatedAt });
  const chats = [chat("old", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"), chat("new", "2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z")];

  it("sorts manual order newest-created first so replies don't reshuffle rows", () => {
    expect(orderChats(chats, "manual").map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(orderChats(chats, "manual", ["old", "new"]).map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("sorts by last activity when asked", () => {
    expect(orderChats(chats, "activity").map((entry) => entry.id)).toEqual(["old", "new"]);
  });
});

describe("moveKey", () => {
  it("swaps with the neighbour and stops at the edges", () => {
    expect(moveKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveKey(["a", "b"], "a", -1)).toBeNull();
    expect(moveKey(["a", "b"], "z", 1)).toBeNull();
  });
});

describe("bot list UI state", () => {
  it("is optional in the settings document and fills its defaults", () => {
    expect(StoreSchema.parse({}).ui).toBeUndefined();
    expect(StoreSchema.parse({ ui: {} }).ui).toEqual(DEFAULT_BOT_LIST_UI);
    expect(DEFAULT_BOT_LIST_UI).toEqual({ collapsed: [], pinnedCollapsed: false, pinnedChats: [], chatOrder: {}, chatSort: "manual", showArchived: false, listWidth: 320, panelWidth: 320, read: {} });
  });

  it("rejects an unknown sort", () => {
    expect(BotListUiSchema.safeParse({ chatSort: "alphabetical" }).success).toBe(false);
  });

  it("keeps read marks", () => {
    const mark = { message: "2026-10-01T09:59:00.000Z", attention: null, at: "2026-10-01T10:01:00.000Z" };
    expect(BotListUiSchema.parse({ read: { chat: mark } }).read).toEqual({ chat: mark });
    expect(BotListUiSchema.safeParse({ read: { chat: { message: null } } }).success).toBe(false);
  });
});

describe("dark avatar backgrounds", () => {
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };

  it("darkens pastel backgrounds and keeps the sprite", () => {
    for (let palette = 0; palette < 12; palette++) {
      const light = pixelAvatar("seed", palette);
      const dark = pixelAvatar("seed", palette, { dark: true });
      expect(dark.rows).toEqual(light.rows);
      expect(luminance(dark.background)).toBeLessThan(0.3);
    }
  });

  it("leaves already dark backgrounds alone", () => {
    expect(darkBackground({ body: "#93C5FD", background: "#0F172A" })).toBe("#0F172A");
  });

  it("is unchanged without the option", () => {
    expect(pixelAvatar("abc")).toEqual(pixelAvatar("abc", null, {}));
  });
});

import { grayscaleAvatar, SPLASH_LINEUP, spriteAvatar } from "../src/shared/avatar";

describe("splash lineup", () => {
  it("has six different creatures, drawn in grays", () => {
    expect(new Set(SPLASH_LINEUP.map((entry) => entry.sprite)).size).toBe(6);
    const gray = grayscaleAvatar(spriteAvatar("cat", 5));
    const colours = [gray.background, ...gray.rows.flat().flatMap((run) => (run.color ? [run.color] : []))];
    for (const colour of colours) expect(colour).toMatch(/^#([0-9a-f]{2})\1\1$/);
  });
});

import { readFileSync } from "node:fs";
import { POCKET_VERSION } from "../src/shared/version";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(POCKET_VERSION).toBe(pkg.version);
  });
});
