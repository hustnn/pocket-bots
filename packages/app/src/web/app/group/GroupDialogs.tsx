import { useState } from "react";
import type { Bot } from "../../../shared/bot";
import { defaultGroupName, GROUP_MAX_BOTS, GROUP_MIN_BOTS, membersProblem, type GroupSummary, type WakeMode } from "../../../shared/group-chat";
import { groupCreateRpc, groupMuteRpc, groupUpdateRpc } from "../../../shared/rpc";
import { Avatar } from "../../components/Avatar";
import { Button, Field, Modal, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useStoreDoc } from "../../lib/data";

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

/** New group chat: pick two to six bots; the group is named after them until renamed. */
export function NewGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (groupId: string) => void }) {
  const doc = useStoreDoc();
  const feedback = useFeedback();
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = membersProblem(selected);
  const generated = defaultGroupName(selected.map((id) => bots.find((bot) => bot.id === id)?.name ?? ""));
  const create = async () => {
    setBusy(true);
    try {
      const { groupId } = await rpc(groupCreateRpc, { name: name.trim() || null, memberIds: selected });
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
        <Field label="Bots" hint="They share one conversation with you. Write normally and they decide who answers; @mention one to give it the request.">
          <BotPicker bots={bots} selected={selected} onChange={setSelected} />
        </Field>
        <Field label="Name" hint="You can rename it any time.">
          <input className="input" value={name} placeholder={selected.length ? generated : "Named after its bots"} onChange={(event) => setName(event.target.value)} />
        </Field>
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
  const [muted, setMuted] = useState<string[]>(group.muted);
  const [busy, setBusy] = useState(false);
  const problem = membersProblem(selected);
  const save = async () => {
    setBusy(true);
    try {
      await rpc(groupUpdateRpc, { groupId: group.id, memberIds: selected, wakeMode });
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
      <Field label="Who a message wakes" hint={wakeMode === "everyone" ? "Every message wakes every bot that isn't muted; each decides whether it has something to add." : "Bots wake only for messages aimed at them; your message to nobody in particular wakes them all."}>
        <select className="select" value={wakeMode} onChange={(event) => setWakeMode(event.target.value as WakeMode)}>
          <option value="everyone">Everyone</option>
          <option value="addressed">Only who it's for</option>
        </select>
      </Field>
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
