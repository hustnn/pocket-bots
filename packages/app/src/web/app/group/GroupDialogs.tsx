import { useState } from "react";
import type { Bot } from "../../../shared/bot";
import type { Coordination } from "../../../shared/group-board";
import { defaultGroupName, GROUP_MAX_BOTS, GROUP_MIN_BOTS, membersProblem, type GroupSummary, type WakeMode } from "../../../shared/group-chat";
import { groupCreateRpc, groupMuteRpc, groupUpdateRpc } from "../../../shared/rpc";
import { Avatar } from "../../components/Avatar";
import { Button, Field, Modal, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useStoreDoc } from "../../lib/data";
import { ExtraFolders, FolderInput, folderProblem } from "../folders";

/** Bots to tick, two to six of them; archived bots can't join. */
function BotPicker({ bots, selected, onChange }: { bots: readonly Bot[]; selected: readonly string[]; onChange: (ids: string[]) => void }) {
  const full = selected.length >= GROUP_MAX_BOTS;
  return (
    <div className="bot-picker">
      {bots.map((bot) => {
        const on = selected.includes(bot.id);
        return (
          <label key={bot.id} className={`check-row bot-pick${on ? " on" : ""}`} style={{ alignItems: "center" }}>
            <input type="checkbox" checked={on} disabled={!on && (full || bot.archived)} onChange={() => onChange(on ? selected.filter((id) => id !== bot.id) : [...selected, bot.id])} />
            <Avatar avatar={bot.avatar} size={26} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ display: "block" }}>
                {bot.name} {bot.archived ? <span className="badge">Archived</span> : null}
              </span>
              {bot.title ? <span className="hint truncate" style={{ display: "block" }}>{bot.title}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** How a group's bots work together: talking in the group (free), led by one of them, or through a shared board. */
type Teamwork = { leaderId: string | null; coordination: Coordination };

/** Picks how the bots work together: free in the chat, led by one of them, or through a shared board. */
function TeamworkPicker({ bots, selected, value, onChange }: { bots: readonly Bot[]; selected: readonly string[]; value: Teamwork; onChange: (next: Teamwork) => void }) {
  const leader = bots.find((bot) => bot.id === value.leaderId);
  const choice = value.coordination === "board" ? "board" : leader ? `lead:${leader.id}` : "free";
  return (
    <Field
      label="How they work together"
      hint={
        value.coordination === "board"
          ? "Shared board: the bots don't message each other. Each request goes to one bot first; if it's bigger than a quick answer, the others join and split it through a shared board of their findings, and the last to finish answers you."
          : leader
            ? `${leader.name} plans every request and hands each piece to the others with a brief. They work only on what ${leader.name} or you hand them, and report back to ${leader.name}.`
            : "Free: every bot reads the conversation and decides for itself whether to take part."
      }
    >
      <select
        className="select"
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "board" ? { leaderId: null, coordination: "board" } : next.startsWith("lead:") ? { leaderId: next.slice(5), coordination: "chat" } : { leaderId: null, coordination: "chat" });
        }}
      >
        <option value="free">Free: they talk in the group</option>
        {bots
          .filter((bot) => selected.includes(bot.id))
          .map((bot) => (
            <option key={bot.id} value={`lead:${bot.id}`}>
              Led by {bot.name}
            </option>
          ))}
        <option value="board">Shared board: they work through a board, not messages</option>
      </select>
    </Field>
  );
}

/** The folder every bot's session for the group works in, like a repo; empty: each bot's own. */
function GroupFolderField({ value, onChange, existing }: { value: string; onChange: (next: string) => void; existing: boolean }) {
  return (
    <Field
      label="Working folder"
      hint={
        <>
          Where every bot works for this group, like a repo on this computer. Empty: each bot works in its own folder. Their memory and skills stay in their own folders.
          {existing ? " A change moves each bot there the next time it starts a turn, with a briefing of where it was." : ""}
        </>
      }
      error={folderProblem(value)}
    >
      <FolderInput value={value} onChange={onChange} placeholder="Each bot's own folder" />
    </Field>
  );
}

/** Folders every bot may use besides the working folder; a change doesn't start any bot over. */
function GroupExtraFoldersField({ value, onChange, cwd }: { value: string[]; onChange: (next: string[]) => void; cwd: string }) {
  return (
    <Field label="Extra folders" hint="More folders every bot in this group can use besides its working folder, like a second repo. Adding or removing one doesn't start the bots over; their next turn uses the new list.">
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <ExtraFolders folders={value} exclude={cwd.trim() ? [cwd.trim()] : []} subject="group" onChange={onChange} />
      </div>
    </Field>
  );
}

/** New group chat: pick two to six bots; the group is named after them until renamed. */
export function NewGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (groupId: string) => void }) {
  const doc = useStoreDoc();
  const feedback = useFeedback();
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  const [selected, setSelected] = useState<string[]>([]);
  const [teamwork, setTeamwork] = useState<Teamwork>({ leaderId: null, coordination: "chat" });
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const problem = membersProblem(selected) ?? folderProblem(folder);
  const generated = defaultGroupName(selected.map((id) => bots.find((bot) => bot.id === id)?.name ?? ""));
  const leader = teamwork.leaderId && selected.includes(teamwork.leaderId) ? teamwork.leaderId : null;
  const create = async () => {
    setBusy(true);
    try {
      const { groupId } = await rpc(groupCreateRpc, { name: name.trim() || null, memberIds: selected, leaderId: leader, cwd: folder.trim() || null, ...(extra.length ? { extraFolders: extra } : {}), ...(teamwork.coordination === "board" ? { coordination: "board" as const } : {}) });
      onCreated(groupId);
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New group chat"
      onClose={onClose}
      footer={
        <>
          <span className="hint grow">{selected.length ? `${selected.length} of ${GROUP_MAX_BOTS} bots` : `Pick ${GROUP_MIN_BOTS} to ${GROUP_MAX_BOTS} bots`}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem} busy={busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        {bots.length < GROUP_MIN_BOTS ? <div className="notice warning">A group chat needs at least two bots. Make another bot first.</div> : null}
        <Field
          label="Bots"
          hint={
            teamwork.coordination === "board"
              ? "They share one conversation with you. Write normally and one takes it, bringing in the others when it's worth sharing; @mention bots to give them the request."
              : leader
                ? "They share one conversation with you, led by the bot you pick below."
                : "They share one conversation with you. Write normally and they decide who answers; @mention one to give it the request."
          }
        >
          <BotPicker bots={bots} selected={selected} onChange={setSelected} />
        </Field>
        {selected.length ? <TeamworkPicker bots={bots} selected={selected} value={{ ...teamwork, leaderId: leader }} onChange={setTeamwork} /> : null}
        <Field label="Name" hint="You can rename it any time.">
          <input className="input" value={name} placeholder={selected.length ? generated : "Named after its bots"} onChange={(event) => setName(event.target.value)} />
        </Field>
        <GroupFolderField value={folder} onChange={setFolder} existing={false} />
        <GroupExtraFoldersField value={extra} onChange={setExtra} cwd={folder} />
      </div>
    </Modal>
  );
}

/** Who's in a group: bots can join or leave later; a bot that leaves has its seat's chat archived. */
export function MembersDialog({ group, onClose }: { group: GroupSummary; onClose: () => void }) {
  const doc = useStoreDoc();
  const feedback = useFeedback();
  const all = doc.data?.values.bots ?? [];
  // Archived members stay listed so they can be taken out.
  const bots = all.filter((bot) => !bot.archived || group.memberIds.includes(bot.id));
  const [selected, setSelected] = useState<string[]>(group.memberIds.filter((id) => all.some((bot) => bot.id === id)));
  const [wakeMode, setWakeMode] = useState<WakeMode>(group.wakeMode);
  const [teamwork, setTeamwork] = useState<Teamwork>({ leaderId: group.leaderId, coordination: group.coordination });
  const [muted, setMuted] = useState<string[]>(group.muted);
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [extra, setExtra] = useState(group.extraFolders);
  const [busy, setBusy] = useState(false);
  const problem = membersProblem(selected) ?? folderProblem(folder);
  const leader = teamwork.leaderId && selected.includes(teamwork.leaderId) ? teamwork.leaderId : null;
  const board = teamwork.coordination === "board";
  const save = async () => {
    setBusy(true);
    try {
      const cwd = folder.trim() || null;
      await rpc(groupUpdateRpc, {
        groupId: group.id,
        memberIds: selected,
        wakeMode,
        ...(leader !== group.leaderId ? { leaderId: leader } : {}),
        ...(teamwork.coordination !== group.coordination ? { coordination: teamwork.coordination } : {}),
        ...(cwd !== group.cwd ? { cwd } : {}),
        ...(JSON.stringify(extra) !== JSON.stringify(group.extraFolders) ? { extraFolders: extra } : {}),
      });
      for (const botId of selected) {
        const want = muted.includes(botId);
        if (want !== group.muted.includes(botId)) await rpc(groupMuteRpc, { groupId: group.id, botId, muted: want });
      }
      onClose();
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${group.name}: members and settings`}
      onClose={onClose}
      footer={
        <>
          <span className="hint grow">{problem ?? `${selected.length} of ${GROUP_MAX_BOTS} bots`}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem} busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <BotPicker bots={bots} selected={selected} onChange={setSelected} />
      <TeamworkPicker bots={bots} selected={selected} value={{ ...teamwork, leaderId: leader }} onChange={setTeamwork} />
      {teamwork.coordination !== group.coordination ? <div className="notice">Each bot starts over at its next turn, with a briefing of where it was: a session keeps the instructions and tools it began with.</div> : null}
      <GroupFolderField value={folder} onChange={setFolder} existing />
      <GroupExtraFoldersField value={extra} onChange={setExtra} cwd={folder} />
      {board ? null : <Field
        label={leader ? "Who a message wakes the leader for" : "Who a message wakes"}
        hint={
          wakeMode === "everyone"
            ? leader
              ? "Every message wakes the leader; the other bots wake only for what the leader or you hand them."
              : "Every message wakes every bot that isn't muted; each decides whether it has something to add."
            : leader
              ? "The leader wakes only for messages aimed at it and your messages to nobody in particular; the other bots wake only for what the leader or you hand them."
              : "Bots wake only for messages aimed at them; your message to nobody in particular wakes them all."
        }
      >
        <select className="select" value={wakeMode} onChange={(event) => setWakeMode(event.target.value as WakeMode)}>
          <option value="everyone">Everyone</option>
          <option value="addressed">Only who it's for</option>
        </select>
      </Field>}
      <Field label="Muted" hint="A muted bot wakes only when it's @mentioned or replied to.">
        <div className="stack" style={{ gap: 4 }}>
          {bots
            .filter((bot) => selected.includes(bot.id))
            .map((bot) => (
              <label key={bot.id} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={muted.includes(bot.id)} onChange={(event) => setMuted((current) => (event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id)))} />
                {bot.name}
              </label>
            ))}
        </div>
      </Field>
    </Modal>
  );
}
