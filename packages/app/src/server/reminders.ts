// Reminders in group chats: a bot's own wake-up, anchored to a group message, that fires to that
// bot only. This file holds the pure parts: recurrence rules, durations, and the texts a bot reads.

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAY_ORDER: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type Rule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number; tz: string }
  | { kind: "weekly"; days: Weekday[]; hour: number; minute: number; tz: string };

export interface Recurrence {
  version: 1;
  rule: Rule;
}

const INTERVAL_MIN_SECONDS = 30;
const INTERVAL_MAX_SECONDS = 365 * 24 * 3600;
/** How far ahead a reminder may fire: a year. */
export const REMINDER_MAX_HORIZON_MS = 365 * 24 * 3600_000;
/** A fire_at further out than this gets a warning: it may have been meant as relative. */
const FIRE_AT_WARN_HORIZON_MS = 24 * 3600_000;
export const REMINDER_TITLE_MAX = 500;

/** The time zone daily and weekly rules resolve in: this computer's, fixed when scheduled. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The repeat grammar: every:<N>(m|h|d), daily@HH:MM, weekly:<dow-list>@HH:MM. */
export function parseRecurrence(input: string, tz: string): { ok: true; recurrence: Recurrence } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: "repeat rule is empty" };
  if (text.startsWith("every:")) {
    const match = /^(\d+)([mhd])$/.exec(text.slice("every:".length));
    if (!match) return { ok: false, error: `every:<N>(m|h|d) expected (e.g. every:15m, every:2h, every:1d), got "${text}"` };
    const n = Number(match[1]);
    const seconds = match[2] === "m" ? n * 60 : match[2] === "h" ? n * 3600 : n * 86400;
    if (seconds < INTERVAL_MIN_SECONDS) return { ok: false, error: `interval must be >= 30s; got ${seconds}s` };
    if (seconds > INTERVAL_MAX_SECONDS) return { ok: false, error: "interval must be <= 1 year" };
    return { ok: true, recurrence: { version: 1, rule: { kind: "interval", seconds } } };
  }
  if (text.startsWith("daily@")) {
    const hm = parseHM(text.slice("daily@".length));
    if (!hm.ok) return { ok: false, error: `${text}: ${hm.error}` };
    return { ok: true, recurrence: { version: 1, rule: { kind: "daily", hour: hm.hour, minute: hm.minute, tz } } };
  }
  if (text.startsWith("weekly:")) {
    const rest = text.slice("weekly:".length);
    const at = rest.lastIndexOf("@");
    if (at === -1) return { ok: false, error: `weekly:<dow-list>@HH:MM expected, got "${text}"` };
    const seen = new Set<Weekday>();
    for (const token of rest.slice(0, at).split(",").map((day) => day.trim().toLowerCase())) {
      if (!(WEEKDAY_ORDER as string[]).includes(token)) return { ok: false, error: `unknown weekday "${token}"; use sun,mon,tue,wed,thu,fri,sat` };
      seen.add(token as Weekday);
    }
    const days = WEEKDAY_ORDER.filter((day) => seen.has(day));
    if (days.length === 0) return { ok: false, error: "weekly: no valid weekdays parsed" };
    const hm = parseHM(rest.slice(at + 1));
    if (!hm.ok) return { ok: false, error: `weekly: ${hm.error}` };
    return { ok: true, recurrence: { version: 1, rule: { kind: "weekly", days, hour: hm.hour, minute: hm.minute, tz } } };
  }
  return { ok: false, error: `unknown repeat form "${text}"; expected every:<N>(m|h|d) | daily@HH:MM | weekly:<dow-list>@HH:MM` };
}

function parseHM(text: string): { ok: true; hour: number; minute: number } | { ok: false; error: string } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return { ok: false, error: `expected HH:MM, got "${text}"` };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) return { ok: false, error: `hour must be 0-23, got ${match[1]}` };
  if (minute > 59) return { ok: false, error: `minute must be 0-59, got ${match[2]}` };
  return { ok: true, hour, minute };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function formatRecurrence(recurrence: Recurrence): string {
  const rule = recurrence.rule;
  if (rule.kind === "interval") return `every ${formatSeconds(rule.seconds)}`;
  if (rule.kind === "daily") return `daily at ${pad2(rule.hour)}:${pad2(rule.minute)} ${rule.tz}`;
  return `weekly ${rule.days.join(",")} at ${pad2(rule.hour)}:${pad2(rule.minute)} ${rule.tz}`;
}

/** The next fire strictly after `from`; daily and weekly resolve HH:MM in the rule's own time zone. */
export function computeNextFire(recurrence: Recurrence, from: Date): Date {
  const rule = recurrence.rule;
  if (rule.kind === "interval") return new Date(from.getTime() + rule.seconds * 1000);
  return nextHM(from, rule.hour, rule.minute, rule.tz, rule.kind === "weekly" ? rule.days : null);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAY_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(utc: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false });
  for (const part of format.formatToParts(utc)) parts[part.type] = part.value;
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAY_NUMBER[parts.weekday!] ?? 0 };
}

function offsetMinutes(utc: Date, tz: string): number {
  const p = zonedParts(utc, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utc.getTime()) / 60000);
}

/** The UTC instant that reads as this wall-clock time in `tz` (DST handled by one correction). */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(new Date(naive), tz);
  const guess = naive - first * 60000;
  const second = offsetMinutes(new Date(guess), tz);
  return new Date(first === second ? guess : naive - second * 60000);
}

function nextHM(from: Date, hour: number, minute: number, tz: string, weekdays: Weekday[] | null): Date {
  const start = zonedParts(from, tz);
  for (let offset = 0; offset < 8; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day) + offset * 86400000);
    const candidate = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, tz);
    if (candidate.getTime() <= from.getTime()) continue;
    if (weekdays && !weekdays.some((day) => WEEKDAY_ORDER.indexOf(day) === zonedParts(candidate, tz).weekday)) continue;
    return candidate;
  }
  throw new Error(`no fire time found within 8 days for ${pad2(hour)}:${pad2(minute)} ${tz}`);
}

/** Durations for snooze's `by` and update's `in`: 30s, 15m, 2h, 1d. */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const n = Number(match[1]);
  const seconds = match[2] === "s" ? n : match[2] === "m" ? n * 60 : match[2] === "h" ? n * 3600 : n * 86400;
  return seconds > 0 ? seconds : null;
}

/** When a schedule fires: delay_seconds or fire_at (not both), within a year, a warning for fire_at past 24h. */
export function resolveFireAt(input: { delaySeconds?: number | null; fireAt?: string | null }, now: number): { ok: true; fireAt: Date; warning?: string } | { ok: false; error: string } {
  const hasDelay = input.delaySeconds !== undefined && input.delaySeconds !== null;
  const hasFireAt = input.fireAt !== undefined && input.fireAt !== null && input.fireAt !== "";
  if (hasDelay && hasFireAt) return { ok: false, error: "Give either delay_seconds or fire_at, not both" };
  if (!hasDelay && !hasFireAt) return { ok: false, error: "Give delay_seconds (preferred for relative times) or fire_at (ISO-8601 UTC)" };
  if (hasDelay) {
    const delay = input.delaySeconds!;
    if (!Number.isInteger(delay) || delay <= 0) return { ok: false, error: "delay_seconds must be a positive integer" };
    if (delay * 1000 > REMINDER_MAX_HORIZON_MS) return { ok: false, error: "delay_seconds must be within 1 year" };
    return { ok: true, fireAt: new Date(now + delay * 1000) };
  }
  const fireAt = new Date(input.fireAt!);
  if (Number.isNaN(fireAt.getTime())) return { ok: false, error: "fire_at must be a valid ISO-8601 timestamp" };
  const delta = fireAt.getTime() - now;
  if (delta <= 0) return { ok: false, error: "fire_at must be in the future" };
  if (delta > REMINDER_MAX_HORIZON_MS) return { ok: false, error: "fire_at must be within 1 year" };
  if (delta > FIRE_AT_WARN_HORIZON_MS) {
    return { ok: true, fireAt, warning: `fire_at is ${Math.round(delta / 3600_000)}h in the future — if this was meant to be relative ("in N minutes"), use delay_seconds instead.` };
  }
  return { ok: true, fireAt };
}

export type ReminderStatus = "scheduled" | "fired" | "canceled";

export interface Reminder {
  id: string;
  groupId: string;
  ownerId: string;
  /** The message it's about. */
  anchor: number;
  /** The anchor's thread, when it's in one. */
  anchorThread: number | null;
  title: string;
  fireAt: string;
  recurrence: Recurrence | null;
  status: ReminderStatus;
  version: number;
  firedAt: string | null;
}

export interface ReminderEvent {
  at: string;
  event: "scheduled" | "fired" | "snoozed" | "updated" | "canceled";
  actor: string;
  nextFireAt: string | null;
}

const MODIFY_HINT = "(to modify: snooze/update/cancel; group_reminder)";
const shortId = (id: string) => id.slice(0, 8);
const kind = (reminder: Reminder) => (reminder.recurrence ? `(recurring · ${formatRecurrence(reminder.recurrence)})` : "(one-time)");
const ref = (reminder: Reminder) => `#${reminder.anchor}${reminder.anchorThread ? ` in thread #${reminder.anchorThread}` : ""}`;

/** One reminder in a list, marked OVERDUE when a scheduled one is past due. */
export function reminderLine(reminder: Reminder, now: Date): string {
  const time = reminder.status === "fired" ? `fired_at=${reminder.firedAt ?? reminder.fireAt}` : `next=${reminder.fireAt}`;
  const overdue = reminder.status === "scheduled" && Date.parse(reminder.fireAt) < now.getTime();
  return `#${shortId(reminder.id)} [${reminder.status}] ${kind(reminder)} ${time}${overdue ? " OVERDUE" : ""} "${reminder.title}" ref=${ref(reminder)}`;
}

export function reminderReceipt(action: "scheduled" | "snoozed" | "updated", reminder: Reminder, warning?: string): string {
  return [`Reminder ${action}: #${shortId(reminder.id)} ${kind(reminder)} "${reminder.title}"`, `Next: ${reminder.fireAt}`, MODIFY_HINT, ...(warning ? [`Warning: ${warning}`] : [])].join("\n");
}

export const reminderCanceled = (reminder: Reminder) => `Reminder canceled: #${shortId(reminder.id)} [${reminder.status}] "${reminder.title}"`;

export function reminderLog(events: readonly ReminderEvent[]): string {
  if (events.length === 0) return "No reminder events.";
  return events.map((event) => `${event.at} ${event.event.toUpperCase()} by ${event.actor} next=${event.nextFireAt ?? "none"}`).join("\n");
}

/**
 * What the owner bot gets when its reminder fires: the
 * reminder, its anchor and, for a recurring one, the next time. It reaches that bot only.
 */
export function reminderFiredText(reminder: Reminder, catchup: boolean): string {
  const prefix = `🔔 Reminder #${shortId(reminder.id)} (${catchup ? "catchup · " : ""}${reminder.recurrence ? "recurring" : "one-time"})`;
  return [
    `${prefix} — ${ref(reminder)} — "${reminder.title}"`,
    ...(reminder.recurrence && reminder.status === "scheduled" ? [`Next iteration: ${reminder.fireAt}`] : []),
    reminder.recurrence ? "(to snooze/update/cancel: group_reminder)" : "(to snooze/cancel: group_reminder)",
  ].join("\n");
}
