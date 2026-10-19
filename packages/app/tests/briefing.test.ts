import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../src/shared/chat-types";
import type { GroupMessage } from "../src/shared/group-chat";
import { briefingPanel } from "../src/server/briefing";

const message = (seq: number, text: string): GroupMessage => ({ seq, at: "2026-10-17T10:00:00.000Z", from: { kind: "user" }, text, replyTo: null, thread: null, replies: 0, lastReplyAt: null, mentions: [], everyone: false, attachments: [], task: null, reactions: [] });

let seq = 0;
const tool = (at: string, detail: Extract<TimelineEntry["item"], { type: "tool_call" }>["detail"], status: "completed" | "failed" = "completed"): TimelineEntry => ({
  provider: "fake",
  timestamp: at,
  seqStart: ++seq,
  seqEnd: seq,
  item: { type: "tool_call", callId: `c${seq}`, name: detail.type, status, error: null, detail },
});

describe("a renewed seat's briefing", () => {
  it("shows recent messages, the files in play as they are now, and the last actions, within its budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-briefing-"));
    writeFileSync(join(dir, "plan.md"), "# Plan\nShip on Friday.\n");
    writeFileSync(join(dir, "api-token.txt"), "do-not-show");
    writeFileSync(join(dir, "old.md"), "stale notes");
    const entries = [
      tool("2026-10-17T06:00:00.000Z", { type: "read", filePath: "old.md" }),
      ...Array.from({ length: 14 }, (_, index) => tool(`2026-10-17T09:${String(10 + index).padStart(2, "0")}:00.000Z`, { type: "shell", command: `npm test -- part ${index}` })),
      tool("2026-10-17T09:40:00.000Z", { type: "edit", filePath: join(dir, "plan.md") }),
      tool("2026-10-17T09:41:00.000Z", { type: "read", filePath: "api-token.txt" }),
      tool("2026-10-17T09:42:00.000Z", { type: "shell", command: "npm run build" }, "failed"),
    ];
    const text = await briefingPanel({ messages: [message(1, "Plan the launch"), message(2, "y".repeat(40_000)), message(3, "x".repeat(40_000))], entries, cwd: dir, meId: "w" });
    expect(text).toMatch(/^This conversation for the group was renewed/);
    // A very long message is cut, and the section drops whole oldest messages to stay under its cap.
    expect(text).toContain("[… truncated]");
    expect(text).not.toContain("Plan the launch");
    expect(text).not.toContain("yyyy");
    expect(text).toContain("xxxx");
    // Files: re-read now when in play; a pointer when it's sensitive or out of play.
    expect(text).toContain(`<object name="${join(dir, "plan.md")}" touched="1x" freshness="current, re-read just now">\n# Plan\nShip on Friday.`);
    expect(text).toContain(`<object name="${join(dir, "api-token.txt")}" touched="1x" last-observed=`);
    expect(text).not.toContain("do-not-show");
    expect(text).toContain(`<object name="${join(dir, "old.md")}" touched="1x" last-observed="2026-10-17T06:00:00.000Z"/>`);
    expect(text).not.toContain("stale notes");
    // The last 12 actions, oldest first, failures marked.
    expect(text).toContain('<recent-actions span="12 of 18" order="oldest first">');
    expect(text).toContain("- 09:42Z shell: npm run build !failed");
    expect(text).not.toContain("part 4");
  });
});
