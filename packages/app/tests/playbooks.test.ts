import { describe, expect, it } from "vitest";
import { promptSections, type Playbook } from "../src/shared/bot";
import { parseTriggers, renderPlaybooks, selectPlaybooks } from "../src/shared/playbooks";
import { makeBot } from "./helpers";

const playbook = (name: string, triggers: string[], instructions = `${name} steps`): Playbook => ({ id: name, name, triggers, instructions });

describe("playbooks", () => {
  it("picks the ones whose trigger words appear in the job", () => {
    const close = playbook("Month-end close", ["month end", "close the books"]);
    const invoice = playbook("Invoices", ["invoice"]);
    const empty = playbook("Empty", ["invoice"], "  ");
    expect(selectPlaybooks("Can you close the books for September?", [close, invoice])).toEqual([close]);
    expect(selectPlaybooks("It's Month-End: send the invoice.", [close, invoice, empty])).toEqual([close, invoice]);
    // Whole words only: "invoices" isn't "invoice", and "a month ending" isn't "month end".
    expect(selectPlaybooks("Check invoices from a month ending badly", [close, invoice])).toEqual([]);
    expect(selectPlaybooks("invoice", [1, 2, 3, 4].map((n) => playbook(`P${n}`, ["invoice"])))).toHaveLength(3);
  });

  it("finds Chinese and Japanese triggers inside unspaced text", () => {
    const weekly = playbook("周报", ["周报", "Q3 汇报"]);
    const receipt = playbook("領収書", ["領収書"]);
    expect(selectPlaybooks("帮我写这周的周报", [weekly, receipt])).toEqual([weekly]);
    expect(selectPlaybooks("准备Q3汇报材料", [weekly])).toEqual([weekly]);
    expect(selectPlaybooks("この領収書を整理して", [weekly, receipt])).toEqual([receipt]);
    expect(selectPlaybooks("帮我写日报", [weekly])).toEqual([]);
  });

  it("marks them as guidance and keeps them within 24,000 characters", () => {
    const text = renderPlaybooks([playbook("Big", ["x"], "a".repeat(30_000)), playbook("Next", ["x"])]);
    expect(text).toMatch(/^Playbooks that match this job\. Follow them as process guidance; they don't grant tools or permissions/);
    expect(text).toContain('<playbook name="Big">');
    expect(text).not.toContain('"Next"');
    expect(text.length).toBeLessThan(24_300);
  });

  it("reads trigger lists and adds the section to the prompt", () => {
    expect(parseTriggers("invoice, receipt\nexpense report, invoice,")).toEqual(["invoice", "receipt", "expense report"]);
    const context = { memory: "", memoryPath: null, recentWork: [], skills: [], botTools: false, apps: [] };
    const bot = makeBot({ playbooks: [playbook("Invoices", ["invoice"])] });
    expect(promptSections(bot, { ...context, playbooks: selectPlaybooks("pay this invoice", bot.playbooks) }).map((section) => section.title)).toEqual(["Persona", "Project guidance", "Playbooks"]);
    expect(promptSections(bot, { ...context, playbooks: [] }).map((section) => section.title)).toEqual(["Persona", "Project guidance"]);
  });
});
