import { describe, expect, it } from "vitest";
import type { Routine } from "../src/shared/bot";
import type { RoutineRun } from "../src/shared/rpc";
import { routineSummary, runTime } from "../src/web/lib/routines";

const now = new Date("2026-10-13T10:00:00Z");
const routine = (id: string, schedule: Routine["schedule"], enabled = true): Routine =>
  ({ id, name: id, prompt: "go", enabled, schedule, resultsChatId: null, createdAt: "2026-10-01T00:00:00Z" }) as Routine;
const run = (id: string, startedAt: string): RoutineRun => ({ id, trigger: "schedule", scheduledFor: startedAt, startedAt, endedAt: null, status: "succeeded", agentId: `chat-${id}`, output: null, error: null });

describe("a bot's routines at a glance", () => {
  it("lists the coming runs of enabled routines, soonest first, within a week", () => {
    const hourly = routine("hourly", { kind: "interval", minutes: 60 });
    const soon = routine("soon", { kind: "once", at: "2026-10-13T10:30:00Z" });
    const far = routine("far", { kind: "once", at: "2026-11-30T10:00:00Z" });
    const off = routine("off", { kind: "interval", minutes: 5 }, false);
    const hook = routine("hook", { kind: "webhook" });
    const records = { hourly: { lastRunAt: "2026-10-13T09:40:00Z", runs: [] } };
    const { upcoming } = routineSummary([hourly, soon, far, off, hook], records, now);
    expect(upcoming.map(({ at, routine: entry }) => [entry.id, at.toISOString()]).slice(0, 3)).toEqual([
      ["soon", "2026-10-13T10:30:00.000Z"],
      ["hourly", "2026-10-13T10:40:00.000Z"],
      ["hourly", "2026-10-13T11:40:00.000Z"],
    ]);
    expect(upcoming).toHaveLength(8);
    expect(upcoming.some(({ routine: entry }) => ["far", "off", "hook"].includes(entry.id))).toBe(false);
  });

  it("merges every routine's runs, newest first", () => {
    const a = routine("a", { kind: "webhook" });
    const b = routine("b", { kind: "webhook" });
    const records = {
      a: { lastRunAt: null, runs: [run("a1", "2026-10-12T08:00:00Z"), run("a2", "2026-10-13T08:00:00Z")] },
      b: { lastRunAt: null, runs: [run("b1", "2026-10-12T20:00:00Z")] },
    };
    expect(routineSummary([a, b], records, now).recent.map(({ run: entry }) => entry.id)).toEqual(["a2", "b1", "a1"]);
  });

  it("names nearby days", () => {
    const local = new Date(2026, 9, 13, 12, 0);
    expect(runTime(new Date(2026, 9, 13, 9, 5), local)).toMatch(/^Today /);
    expect(runTime(new Date(2026, 9, 14, 9, 5), local)).toMatch(/^Tomorrow /);
    expect(runTime(new Date(2026, 9, 12, 9, 5), local)).toMatch(/^Yesterday /);
    expect(runTime(new Date(2026, 9, 20, 9, 5), local)).not.toMatch(/^(Today|Tomorrow|Yesterday) /);
  });
});
