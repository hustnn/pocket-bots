import { describe, expect, it } from "vitest";
import { speakableText, speechChunks, voiceGroups } from "../src/shared/speech";

describe("reading replies aloud", () => {
  it("reads the words, not the markdown", () => {
    const reply = "## Done\n\nI **saved** the [report](https://x.test/r) as `report.md`:\n\n```ts\nconst a = 1;\n```\n\n- first\n- second\n\nSee https://example.com for more.";
    expect(speakableText(reply)).toBe("Done I saved the report as report.md: first second See for more.");
  });

  it("reads long replies in whole sentences of a couple hundred characters", () => {
    const sentence = "This sentence is about fifty characters long, ok. ";
    const chunks = speechChunks(sentence.repeat(10));
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 220 && chunk.endsWith("ok."))).toBe(true);
    expect(speechChunks("```\ncode only\n```")).toEqual([]);
  });

  it("splits Chinese at its own full stops, and very long sentences at their commas", () => {
    const sentence = "今天我们完成了设置面板的修复，并且验证了技能读取不再弹出审批。";
    const chunks = speechChunks(sentence.repeat(12));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 220 && chunk.endsWith("审批。"))).toBe(true);
    const run = `${"很长的一句话没有句号".repeat(20)}，${"后半句也很长".repeat(30)}`;
    expect(speechChunks(run).every((chunk) => chunk.length <= 220)).toBe(true);
    expect(speechChunks(run).join("").replace(/\s/g, "")).toBe(run);
  });

  it("groups voices by language, the reader's languages first", () => {
    const voices = [
      { name: "Samantha", lang: "en-US" },
      { name: "Tingting", lang: "zh-CN" },
      { name: "Anna", lang: "de-DE" },
      { name: "Meijia", lang: "zh-TW" },
      { name: "Arthur", lang: "en-GB" },
    ];
    const names: Record<string, string> = { en: "English", zh: "Chinese", de: "German" };
    const groups = voiceGroups(voices, ["zh-CN", "en"], (code) => names[code] ?? code);
    expect(groups.map((group) => [group.label, group.voices.map((voice) => voice.name)])).toEqual([
      ["Chinese", ["Meijia", "Tingting"]],
      ["English", ["Arthur", "Samantha"]],
      ["German", ["Anna"]],
    ]);
  });
});
