import { useState } from "react";
import { newRoutineId, type Bot, type Routine, type RoutineSchedule } from "../../../shared/bot";
import { displayTitle } from "../../../shared/chat";
import { CRON_PRESETS, describeSchedule, formatLocalDateTime, nextRun, parseLocalDateTime, validateCron } from "../../../shared/routines";
import { routineRunNowRpc, routineWebhookRpc, type RoutineRecord, type RoutineRun } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { Button, Field, IconButton, MenuButton, Modal, Segmented, Toggle, useAction, useFeedback } from "../../components/ui";
import { rpc } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { useBotChats, useRoutineStatus } from "../../lib/data";
import { navigate } from "../../lib/router";
import { routineSummary, runTime, UPCOMING_DAYS } from "../../lib/routines";
import { Section, useUpdateBot } from "./common";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RUN_LABEL: Record<RoutineRun["status"], string> = { running: "Running", succeeded: "Done", failed: "Failed", "skipped-busy": "Skipped", "skipped-missed": "Missed" };
const RUN_TONE: Record<RoutineRun["status"], string> = { running: "accent", succeeded: "success", failed: "danger", "skipped-busy": "", "skipped-missed": "warning" };

type Kind = RoutineSchedule["kind"];

function defaultSchedule(kind: Kind): RoutineSchedule {
  switch (kind) {
    case "daily":
      return { kind, time: "09:00", weekdays: [1, 2, 3, 4, 5] };
    case "interval":
      return { kind, minutes: 60 };
    case "once":
      return { kind, at: new Date(Date.now() + 3_600_000).toISOString() };
    case "cron":
      return { kind, expression: "0 9 * * 1-5" };
    case "webhook":
      return { kind };
  }
}

function RoutineEditor({ bot, routine, onClose }: { bot: Bot; routine: Routine | null; onClose: () => void }) {
  const update = useUpdateBot();
  const chats = useBotChats(bot.id);
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(routine?.schedule ?? defaultSchedule("daily"));
  const [resultsChatId, setResultsChatId] = useState<string | null>(routine?.resultsChatId ?? null);
  const [onceText, setOnceText] = useState(schedule.kind === "once" ? formatLocalDateTime(new Date(schedule.at)) : formatLocalDateTime(new Date(Date.now() + 3_600_000)));
  const cronError = schedule.kind === "cron" ? validateCron(schedule.expression) : null;
  const onceAt = schedule.kind === "once" ? parseLocalDateTime(onceText) : null;
  const problems = [!name.trim() ? "Give it a name." : null, !prompt.trim() ? "Write what it should do." : null, cronError, schedule.kind === "once" && !onceAt ? "Use YYYY-MM-DD HH:MM." : null, schedule.kind === "daily" && schedule.weekdays.length === 0 ? "Pick at least one day." : null].filter(
    (problem): problem is string => !!problem,
  );

  const save = async () => {
    const finalSchedule: RoutineSchedule = schedule.kind === "once" && onceAt ? { kind: "once", at: onceAt.toISOString() } : schedule;
    const saved: Routine = routine
      ? { ...routine, name: name.trim(), prompt: prompt.trim(), schedule: finalSchedule, resultsChatId }
      : { id: newRoutineId(), name: name.trim(), prompt: prompt.trim(), enabled: true, schedule: finalSchedule, resultsChatId, createdAt: new Date().toISOString() };
    const ok = await update(bot.id, (current) => ({ ...current, routines: routine ? current.routines.map((entry) => (entry.id === routine.id ? saved : entry)) : [...current.routines, saved] }));
    if (ok) onClose();
  };

  return (
    <Modal
      title={routine ? "Edit routine" : "New routine"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={problems.length > 0} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={name} placeholder="Morning inbox check" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="What to do" hint="The first message of each run. Each run gets its own chat.">
          <textarea className="textarea" rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Field label="When">
          <Segmented<Kind>
            value={schedule.kind}
            onChange={(kind) => setSchedule(defaultSchedule(kind))}
            options={[
              { value: "daily", label: "Days" },
              { value: "interval", label: "Every" },
              { value: "cron", label: "Cron" },
              { value: "once", label: "Once" },
              { value: "webhook", label: "Webhook" },
            ]}
          />
        </Field>
        {schedule.kind === "daily" ? (
          <div className="row wrap">
            <input className="input" type="time" style={{ width: 120 }} value={schedule.time} onChange={(event) => setSchedule({ ...schedule, time: event.target.value })} />
            {WEEKDAYS.map((day, index) => (
              <button
                key={day}
                type="button"
                className={`tab${schedule.weekdays.includes(index) ? " active" : ""}`}
                onClick={() => setSchedule({ ...schedule, weekdays: schedule.weekdays.includes(index) ? schedule.weekdays.filter((entry) => entry !== index) : [...schedule.weekdays, index].sort() })}
              >
                {day}
              </button>
            ))}
          </div>
        ) : null}
        {schedule.kind === "interval" ? (
          <div className="row">
            <input className="input" type="number" min={5} max={1440} style={{ width: 110 }} value={schedule.minutes} onChange={(event) => setSchedule({ ...schedule, minutes: Math.max(5, Math.min(1440, Number(event.target.value) || 5)) })} />
            <span className="muted">minutes</span>
          </div>
        ) : null}
        {schedule.kind === "cron" ? (
          <Field label="Cron (minute hour day month weekday, local time)" error={cronError}>
            <input className="input mono" value={schedule.expression} onChange={(event) => setSchedule({ ...schedule, expression: event.target.value })} />
            <div className="row wrap">
              {CRON_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className="tab" onClick={() => setSchedule({ kind: "cron", expression: preset.expression })}>
                  {preset.label}
                </button>
              ))}
            </div>
          </Field>
        ) : null}
        {schedule.kind === "once" ? (
          <Field label="At (local time)" error={onceAt ? null : "Use YYYY-MM-DD HH:MM."}>
            <input className="input mono" value={onceText} onChange={(event) => setOnceText(event.target.value)} />
          </Field>
        ) : null}
        {schedule.kind === "webhook" ? <div className="hint">It runs when its webhook URL on this computer gets a POST. The URL is in the routine's menu after saving.</div> : null}
        <Field label="Post results to" hint="A chat of this bot that gets a card for each run.">
          <select className="select" value={resultsChatId ?? ""} onChange={(event) => setResultsChatId(event.target.value || null)}>
            <option value="">Nowhere</option>
            {(chats.data ?? []).map((chat) => (
              <option key={chat.id} value={chat.id}>
                {displayTitle(chat.title)}
              </option>
            ))}
          </select>
        </Field>
        {problems.length ? <div className="error-text">{problems[0]}</div> : null}
      </div>
    </Modal>
  );
}

function RoutineCard({ bot, routine, runs, onEdit }: { bot: Bot; routine: Routine; runs: RoutineRun[]; onEdit: () => void }) {
  const update = useUpdateBot();
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const [history, setHistory] = useState(false);
  const latest = runs[runs.length - 1];
  const next = routine.enabled ? nextRun(routine.schedule, new Date(latest?.startedAt ?? routine.createdAt), new Date()) : null;

  const copyWebhook = (rotate: boolean) =>
    void run("hook", async () => {
      const { url } = await rpc(routineWebhookRpc, { routineId: routine.id, rotate });
      try {
        await copyText(url);
        feedback.toast(rotate ? "New webhook URL copied" : "Webhook URL copied");
      } catch {
        // Show it to copy by hand rather than lose a URL that was just made.
        await feedback.prompt({ title: rotate ? "New webhook URL" : "Webhook URL", value: url, action: "Done", optional: true });
      }
    });

  const remove = async () => {
    if (!(await feedback.confirm({ title: `Delete "${routine.name}"?`, body: "Its past runs' chats stay.", action: "Delete", danger: true }))) return;
    await update(bot.id, (current) => ({ ...current, routines: current.routines.filter((entry) => entry.id !== routine.id) }));
  };

  return (
    <div className="card stack" style={{ gap: 6 }} id={`routine-${routine.id}`}>
      <div className="row">
        <strong style={{ flex: 1 }} className="truncate">
          {routine.name}
        </strong>
        <Toggle on={routine.enabled} label="Enabled" onChange={(enabled) => void update(bot.id, (current) => ({ ...current, routines: current.routines.map((entry) => (entry.id === routine.id ? { ...entry, enabled } : entry)) }))} />
        <MenuButton
          entries={[
            { label: "Edit", icon: "edit", onSelect: onEdit },
            ...(routine.schedule.kind === "webhook"
              ? [
                  { label: "Copy webhook URL", icon: "link" as const, onSelect: () => copyWebhook(false) },
                  { label: "New webhook URL", icon: "refresh" as const, onSelect: () => copyWebhook(true) },
                ]
              : []),
            "divider",
            { label: "Delete", icon: "trash", danger: true, onSelect: () => void remove() },
          ]}
        />
      </div>
      <div className="hint">
        {describeSchedule(routine.schedule)}
        {next ? ` · next ${next.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
      </div>
      <div className="row">
        {latest ? <span className={`badge ${RUN_TONE[latest.status]}`}>{`${RUN_LABEL[latest.status]} ${relativeTime(latest.startedAt)}`}</span> : <span className="hint">Never ran</span>}
        <span className="spacer" />
        {runs.length ? (
          <Button small variant="ghost" onClick={() => setHistory(!history)}>
            {history ? "Hide runs" : `${runs.length} runs`}
          </Button>
        ) : null}
        <Button small icon="play" busy={busy === "run"} onClick={() => void run("run", () => rpc(routineRunNowRpc, { botId: bot.id, routineId: routine.id }), "Started a run")}>
          Run now
        </Button>
      </div>
      {history ? (
        <div>
          {[...runs].reverse().map((entry) => (
            <div key={entry.id} className="list-item" onClick={() => entry.agentId && navigate({ page: "bot", botId: bot.id, chatId: entry.agentId })}>
              <span className={`badge ${RUN_TONE[entry.status]}`}>{RUN_LABEL[entry.status]}</span>
              <span className="grow truncate small">{entry.error ?? entry.output ?? entry.trigger}</span>
              <span className="hint">{relativeTime(entry.startedAt)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What runs over the coming days and how the latest runs went, across all the bot's routines. */
function AtAGlance({ bot, records }: { bot: Bot; records: Readonly<Record<string, RoutineRecord>> }) {
  const now = new Date();
  const { upcoming, recent } = routineSummary(bot.routines, records, now);
  return (
    <Section title="At a glance" info={`The next runs over the coming ${UPCOMING_DAYS} days in this computer's local time, and the latest runs. Open a run to see its chat.`}>
      <div className="field-label">Upcoming</div>
      {upcoming.length === 0 ? <div className="hint">Nothing scheduled.</div> : null}
      <div>
        {upcoming.map(({ at, routine }) => (
          <div key={`${routine.id}:${at.getTime()}`} className="list-item" style={{ cursor: "default", padding: "4px 10px" }}>
            <span className="small" style={{ width: 130, flexShrink: 0 }}>
              {runTime(at, now)}
            </span>
            <span className="grow truncate">{routine.name}</span>
          </div>
        ))}
      </div>
      <div className="field-label">Recent runs</div>
      {recent.length === 0 ? <div className="hint">No runs yet.</div> : null}
      <div>
        {recent.map(({ run, routine }) => (
          <div
            key={run.id}
            className="list-item"
            style={{ padding: "4px 10px", cursor: run.agentId ? "pointer" : "default" }}
            title={run.error ?? run.output ?? undefined}
            onClick={() => run.agentId && navigate({ page: "bot", botId: bot.id, chatId: run.agentId })}
          >
            <span className={`badge ${RUN_TONE[run.status]}`}>{RUN_LABEL[run.status]}</span>
            <span className="grow truncate small">
              {routine.name}
              {run.error ?? run.output ? <span className="hint"> · {run.error ?? run.output}</span> : null}
            </span>
            <span className="hint" style={{ flexShrink: 0 }}>
              {runTime(new Date(run.startedAt), now)}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function RoutinesSection({ bot }: { bot: Bot }) {
  const status = useRoutineStatus();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  return (
    <>
      {bot.routines.length ? <AtAGlance bot={bot} records={status.data?.routines ?? {}} /> : null}
      <Section
        title="Routines"
        info="Work the bot does on a schedule or when its webhook is called. Each run starts a new chat. Routines run while pocket-bots is running."
        actions={
          <Button small icon="plus" onClick={() => setEditing("new")}>
            New routine
          </Button>
        }
      >
        {bot.routines.length === 0 ? <div className="hint">No routines. Ask the bot in a chat and it can propose one.</div> : null}
        {bot.routines.map((routine) => (
          <RoutineCard key={routine.id} bot={bot} routine={routine} runs={status.data?.routines[routine.id]?.runs ?? []} onEdit={() => setEditing(routine)} />
        ))}
        {editing ? <RoutineEditor bot={bot} routine={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
        <IconButton icon="refresh" title="Refresh run status" onClick={() => void status.refetch()} />
      </Section>
    </>
  );
}
