// Reminders' pure parts: repeat rules, next fire times, durations and what a bot reads.
import { describe, expect, it } from "vitest";
import {
  computeNextFire,
  formatRecurrence,
  parseDuration,
  parseRecurrence,
  reminderFiredText,
  reminderLine,
  reminderLog,
  reminderReceipt,
  resolveFireAt,
  type Recurrence,
  type Reminder,
} from "../src/server/reminders";

const rule = (text: string, tz = "UTC"): Recurrence => {
  const parsed = parseRecurrence(text, tz);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.recurrence;
};
const next = (text: string, from: string, tz = "UTC") => computeNextFire(rule(text, tz), new Date(from)).toISOString();

describe("repeat rules", () => {
  it("reads every:, daily@ and weekly: and refuses anything else", () => {
    expect(rule("every:15m").rule).toEqual({ kind: "interval", seconds: 900 });
    expect(rule("every:2h").rule).toEqual({ kind: "interval", seconds: 7200 });
    expect(rule("daily@09:00", "Asia/Shanghai").rule).toEqual({ kind: "daily", hour: 9, minute: 0, tz: "Asia/Shanghai" });
    expect(rule("weekly:fri,mon@18:30").rule).toEqual({ kind: "weekly", days: ["mon", "fri"], hour: 18, minute: 30, tz: "UTC" });
    expect(parseRecurrence("every:0m", "UTC")).toEqual({ ok: false, error: "interval must be >= 30s; got 0s" });
    expect(parseRecurrence("every:400d", "UTC")).toEqual({ ok: false, error: "interval must be <= 1 year" });
    expect(parseRecurrence("every:10s", "UTC").ok).toBe(false);
    expect(parseRecurrence("daily@24:00", "UTC")).toEqual({ ok: false, error: "daily@24:00: hour must be 0-23, got 24" });
    expect(parseRecurrence("weekly:funday@09:00", "UTC")).toEqual({ ok: false, error: 'unknown weekday "funday"; use sun,mon,tue,wed,thu,fri,sat' });
    expect(parseRecurrence("hourly", "UTC").ok).toBe(false);
  });

  it("describes a rule the way the list does", () => {
    expect(formatRecurrence(rule("every:90m"))).toBe("every 90m");
    expect(formatRecurrence(rule("every:1d"))).toBe("every 1d");
    expect(formatRecurrence(rule("daily@09:05", "Asia/Shanghai"))).toBe("daily at 09:05 Asia/Shanghai");
    expect(formatRecurrence(rule("weekly:mon,fri@09:00"))).toBe("weekly mon,fri at 09:00 UTC");
  });
});

describe("next fire", () => {
  it("adds an interval, and finds the next wall-clock time strictly after, in the rule's time zone", () => {
    expect(next("every:15m", "2026-10-17T10:00:00.000Z")).toBe("2026-10-17T10:15:00.000Z");
    // 08:30 in Shanghai: 09:00 is today; at 09:00 exactly, it's tomorrow.
    expect(next("daily@09:00", "2026-10-17T00:30:00.000Z", "Asia/Shanghai")).toBe("2026-10-17T01:00:00.000Z");
    expect(next("daily@09:00", "2026-10-17T01:00:00.000Z", "Asia/Shanghai")).toBe("2026-10-18T01:00:00.000Z");
    // 2026-10-17 is a Saturday.
    expect(next("weekly:mon@09:00", "2026-10-17T10:00:00.000Z")).toBe("2026-10-19T09:00:00.000Z");
    expect(next("weekly:sat,mon@09:00", "2026-10-17T08:00:00.000Z")).toBe("2026-10-17T09:00:00.000Z");
  });

  it("keeps 09:00 at 09:00 local across a daylight-saving change", () => {
    // New York leaves daylight saving time on 2026-11-01.
    expect(next("daily@09:00", "2026-10-31T12:00:00.000Z", "America/New_York")).toBe("2026-10-31T13:00:00.000Z");
    expect(next("daily@09:00", "2026-10-31T13:00:00.000Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
  });
});

describe("schedule input and durations", () => {
  const now = Date.parse("2026-10-17T10:00:00.000Z");
  it("takes delay_seconds or fire_at, not both, within a year, and warns about a fire_at past a day", () => {
    expect(resolveFireAt({ delaySeconds: 60, fireAt: "2026-10-17T11:00:00Z" }, now)).toEqual({ ok: false, error: "Give either delay_seconds or fire_at, not both" });
    expect(resolveFireAt({}, now).ok).toBe(false);
    expect(resolveFireAt({ delaySeconds: 90 }, now)).toEqual({ ok: true, fireAt: new Date("2026-10-17T10:01:30.000Z") });
    expect(resolveFireAt({ delaySeconds: 400 * 86400 }, now)).toEqual({ ok: false, error: "delay_seconds must be within 1 year" });
    expect(resolveFireAt({ fireAt: "2026-10-17T09:00:00Z" }, now)).toEqual({ ok: false, error: "fire_at must be in the future" });
    expect(resolveFireAt({ fireAt: "soon" }, now)).toEqual({ ok: false, error: "fire_at must be a valid ISO-8601 timestamp" });
    const far = resolveFireAt({ fireAt: "2026-10-19T10:00:00Z" }, now);
    expect(far.ok && far.warning).toMatch(/^fire_at is 48h in the future — if this was meant to be relative/);
  });

  it("reads durations", () => {
    expect([parseDuration("45s"), parseDuration("30m"), parseDuration("2h"), parseDuration("1d")]).toEqual([45, 1800, 7200, 86400]);
    expect([parseDuration("0m"), parseDuration("5x"), parseDuration("")]).toEqual([null, null, null]);
  });
});

describe("what a bot reads", () => {
  const base: Reminder = {
    id: "0a1b2c3d-0000-4000-8000-000000000000",
    groupId: "group-x",
    ownerId: "ada",
    anchor: 12,
    anchorThread: null,
    title: "check the build",
    fireAt: "2026-10-17T11:00:00.000Z",
    recurrence: null,
    status: "scheduled",
    version: 1,
    firedAt: null,
  };
  const recurring: Reminder = { ...base, anchorThread: 9, recurrence: rule("every:1h") };

  it("lists one per line, marking a scheduled one that's past due", () => {
    expect(reminderLine(base, new Date("2026-10-17T10:00:00Z"))).toBe('#0a1b2c3d [scheduled] (one-time) next=2026-10-17T11:00:00.000Z "check the build" ref=#12');
    expect(reminderLine(recurring, new Date("2026-10-17T12:00:00Z"))).toBe('#0a1b2c3d [scheduled] (recurring · every 1h) next=2026-10-17T11:00:00.000Z OVERDUE "check the build" ref=#12 in thread #9');
    expect(reminderLine({ ...base, status: "fired", firedAt: "2026-10-17T11:00:01.000Z" }, new Date("2026-10-17T12:00:00Z"))).toBe('#0a1b2c3d [fired] (one-time) fired_at=2026-10-17T11:00:01.000Z "check the build" ref=#12');
  });

  it("answers a schedule with the next time and how to change it", () => {
    expect(reminderReceipt("scheduled", base)).toBe(['Reminder scheduled: #0a1b2c3d (one-time) "check the build"', "Next: 2026-10-17T11:00:00.000Z", "(to modify: snooze/update/cancel; group_reminder)"].join("\n"));
    expect(reminderReceipt("updated", base, "careful")).toMatch(/\nWarning: careful$/);
    expect(reminderLog([{ at: "2026-10-17T10:00:00.000Z", event: "scheduled", actor: "Ada", nextFireAt: base.fireAt }, { at: "2026-10-17T11:00:00.000Z", event: "fired", actor: "system", nextFireAt: null }])).toBe(
      ["2026-10-17T10:00:00.000Z SCHEDULED by Ada next=2026-10-17T11:00:00.000Z", "2026-10-17T11:00:00.000Z FIRED by system next=none"].join("\n"),
    );
  });

  it("wakes its owner with the reminder, its anchor and, for a recurring one, the next time", () => {
    expect(reminderFiredText({ ...base, status: "fired" }, false)).toBe(['🔔 Reminder #0a1b2c3d (one-time) — #12 — "check the build"', "(to snooze/cancel: group_reminder)"].join("\n"));
    expect(reminderFiredText({ ...recurring, fireAt: "2026-10-17T12:00:00.000Z" }, true)).toBe(
      ['🔔 Reminder #0a1b2c3d (catchup · recurring) — #12 in thread #9 — "check the build"', "Next iteration: 2026-10-17T12:00:00.000Z", "(to snooze/update/cancel: group_reminder)"].join("\n"),
    );
  });
});
