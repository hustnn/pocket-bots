import type { Routine } from "../../shared/bot";
import { upcomingRuns } from "../../shared/routines";
import type { RoutineRecord, RoutineRun } from "../../shared/rpc";

// A bot's routines at a glance: what runs over the coming days, and how the
// latest runs went, across all of its routines.

export const UPCOMING_DAYS = 7;
const UPCOMING_LIMIT = 8;
const RECENT_LIMIT = 8;

export function routineSummary(
  routines: readonly Routine[],
  records: Readonly<Record<string, RoutineRecord>>,
  now: Date,
): { upcoming: { at: Date; routine: Routine }[]; recent: { run: RoutineRun; routine: Routine }[] } {
  const horizon = now.getTime() + UPCOMING_DAYS * 86_400_000;
  const upcoming = routines
    .filter((routine) => routine.enabled)
    // The schedule counts from its last firing, as the scheduler does.
    .flatMap((routine) => upcomingRuns(routine.schedule, new Date(records[routine.id]?.lastRunAt ?? routine.createdAt), now, UPCOMING_LIMIT).map((at) => ({ at, routine })))
    .filter(({ at }) => at.getTime() <= horizon)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, UPCOMING_LIMIT);
  const recent = routines
    .flatMap((routine) => (records[routine.id]?.runs ?? []).map((run) => ({ run, routine })))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, RECENT_LIMIT);
  return { upcoming, recent };
}

/** "Today 09:00", "Tomorrow 09:00", "Yesterday 18:30", else the date. */
export function runTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const offset = Math.round((day - today) / 86_400_000);
  if (offset === 0) return `Today ${time}`;
  if (offset === 1) return `Tomorrow ${time}`;
  if (offset === -1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}
