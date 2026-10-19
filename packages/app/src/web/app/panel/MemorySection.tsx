import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { dayName, journalSource, journalSummary } from "../../../shared/activity";
import type { Bot } from "../../../shared/bot";
import { memoryDeleteRpc, memoryJournalRpc, memoryListRpc, memoryLogDeleteRpc, memoryLogRpc, memoryReadRpc, memoryUndoRpc, memoryWriteRpc } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { Button, IconButton, Segmented, Toggle, useAction, useFeedback } from "../../components/ui";
import { rpc } from "../../lib/api";
import { Section, useUpdateBot } from "./common";

function FileEditor({ botId, name, botWrites, onDeleted }: { botId: string; name: string; botWrites: boolean; onDeleted: () => void }) {
  const client = useQueryClient();
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const file = useQuery({ queryKey: ["memory", botId, "file", name], queryFn: () => rpc(memoryReadRpc, { botId, name }) });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(null), [name]);
  const value = text ?? file.data?.text ?? "";
  const dirty = text !== null && text !== file.data?.text;
  const refresh = () => client.invalidateQueries({ queryKey: ["memory", botId] });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <textarea className="textarea mono" rows={14} value={value} onChange={(event) => setText(event.target.value)} placeholder={name === "MEMORY.md" ? (botWrites ? "Empty. The bot writes here when it learns something worth keeping." : "Empty. The bot reads this but doesn't write here. Add what it should remember.") : ""} />
      <div className="row">
        <Button
          small
          variant="primary"
          disabled={!dirty}
          busy={busy === "save"}
          onClick={() =>
            void run("save", async () => {
              await rpc(memoryWriteRpc, { botId, name, text: value });
              setText(null);
              await refresh();
            }, "Saved")
          }
        >
          Save
        </Button>
        {dirty ? (
          <Button small onClick={() => setText(null)}>
            Discard
          </Button>
        ) : null}
        <span className="spacer" />
        {name !== "MEMORY.md" ? (
          <Button
            small
            variant="danger"
            icon="trash"
            onClick={async () => {
              if (!(await feedback.confirm({ title: `Delete ${name}?`, body: "You can undo it from Changes.", action: "Delete", danger: true }))) return;
              await run("delete", async () => {
                await rpc(memoryDeleteRpc, { botId, name });
                await refresh();
                onDeleted();
              });
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Files({ bot }: { bot: Bot }) {
  const list = useQuery({ queryKey: ["memory", bot.id, "list"], queryFn: () => rpc(memoryListRpc, { botId: bot.id }) });
  const [selected, setSelected] = useState("MEMORY.md");
  const [newName, setNewName] = useState("");
  const client = useQueryClient();
  const { run } = useAction();
  const files = list.data?.files ?? [];
  return (
    <Section title="Memory files" info={list.data ? `The first ${list.data.injectedLines} lines (${(list.data.injectedBytes / 1000).toFixed(1)} KB) of MEMORY.md go into every new chat. Topic files are read when needed.` : undefined}>
      <div className="row wrap">
        {files.map((file) => (
          <button key={file.name} type="button" className={`tab${file.name === selected ? " active" : ""}`} onClick={() => setSelected(file.name)}>
            {file.name}
            <span className="hint">{file.lines}</span>
          </button>
        ))}
      </div>
      <FileEditor botId={bot.id} name={selected} botWrites={bot.memoryAutoWrite} onDeleted={() => setSelected("MEMORY.md")} />
      <div className="row">
        <input className="input" placeholder="new-topic.md" value={newName} onChange={(event) => setNewName(event.target.value)} />
        <Button
          small
          icon="plus"
          disabled={!/^[A-Za-z0-9 ._-]+\.md$/.test(newName)}
          onClick={() =>
            void run("new", async () => {
              await rpc(memoryWriteRpc, { botId: bot.id, name: newName, text: "" });
              await client.invalidateQueries({ queryKey: ["memory", bot.id] });
              setSelected(newName);
              setNewName("");
            })
          }
        >
          Add topic
        </Button>
      </div>
      {list.data ? <div className="hint mono truncate">{list.data.folder}</div> : null}
    </Section>
  );
}

function DailyLog({ bot }: { bot: Bot }) {
  const [day, setDay] = useState<string | null>(null);
  const client = useQueryClient();
  const feedback = useFeedback();
  const log = useQuery({ queryKey: ["memory", bot.id, "log", day], queryFn: () => rpc(memoryLogRpc, { botId: bot.id, ...(day ? { day } : {}) }) });
  const days = log.data?.days ?? [];
  const now = new Date();
  return (
    <Section title="Daily log" info={`One line per finished turn, written by pocket-bots. The newest lines of the last two days go into new chats as recent work.${bot.memoryAutoWrite ? "" : " No new lines are added while memory writing is off."}`}>
      {days.length === 0 ? <div className="hint">Nothing logged yet.</div> : null}
      <div className="row wrap">
        {days.slice(0, 14).map((entry) => (
          <button key={entry.day} type="button" className={`tab${entry.day === day ? " active" : ""}`} onClick={() => setDay(entry.day === day ? null : entry.day)}>
            {dayName(entry.day, now)} <span className="hint">{entry.lines}</span>
          </button>
        ))}
      </div>
      {day && log.data?.text !== null && log.data?.text !== undefined ? (
        <>
          <pre className="pre-box">{log.data.text || "Empty."}</pre>
          <div className="row">
            <Button
              small
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (!(await feedback.confirm({ title: `Delete the log for ${day}?`, action: "Delete", danger: true }))) return;
                await rpc(memoryLogDeleteRpc, { botId: bot.id, day });
                setDay(null);
                await client.invalidateQueries({ queryKey: ["memory", bot.id, "log"] });
              }}
            >
              Delete day
            </Button>
          </div>
        </>
      ) : null}
    </Section>
  );
}

function Changes({ bot }: { bot: Bot }) {
  const client = useQueryClient();
  const journal = useQuery({ queryKey: ["memory", bot.id, "journal"], queryFn: () => rpc(memoryJournalRpc, { botId: bot.id }) });
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAction();
  const entries = journal.data?.entries ?? [];
  return (
    <Section title="Changes" info="Every change to the memory files, by the bot or by you. Undo puts a file back the way it was.">
      {entries.length === 0 ? <div className="hint">No changes yet.</div> : null}
      {entries.map((entry) => (
        <div key={entry.id} className="stack" style={{ gap: 4 }}>
          <div className="list-item" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
            <div className="grow">
              <div className="small">{journalSummary(entry, bot.name)}</div>
              <div className="hint">
                {journalSource(entry)} · {relativeTime(entry.at)}
              </div>
            </div>
            {entry.canUndo ? (
              <IconButton
                icon="undo"
                title="Undo"
                disabled={busy !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void run(entry.id, async () => {
                    await rpc(memoryUndoRpc, { botId: bot.id, id: entry.id });
                    await client.invalidateQueries({ queryKey: ["memory", bot.id] });
                  }, "Undone");
                }}
              />
            ) : null}
          </div>
          {open === entry.id ? <pre className="pre-box">{entry.diff || "No text changed."}</pre> : null}
        </div>
      ))}
    </Section>
  );
}

export function MemorySection({ bot }: { bot: Bot }) {
  const [view, setView] = useState<"files" | "log" | "changes">("files");
  const update = useUpdateBot();
  return (
    <>
      <Section title="Memory writing" info="Off, the bot can only read its memory. You can still edit it here, and no daily log is kept.">
        <div className="row">
          <span style={{ flex: 1 }}>Let the bot write its own memory and keep a daily log</span>
          <Toggle on={bot.memoryAutoWrite} label="Memory writing" onChange={(memoryAutoWrite) => void update(bot.id, { memoryAutoWrite })} />
        </div>
      </Section>
      <div style={{ padding: "12px 16px 0" }}>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "files", label: "Files" },
            { value: "log", label: "Daily log" },
            { value: "changes", label: "Changes" },
          ]}
        />
      </div>
      {view === "files" ? <Files bot={bot} /> : view === "log" ? <DailyLog bot={bot} /> : <Changes bot={bot} />}
    </>
  );
}
