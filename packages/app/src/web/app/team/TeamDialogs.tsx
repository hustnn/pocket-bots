import { useState } from "react";
import { TEAM_INSTRUCTIONS_MAX, type Bot, type Team } from "../../../shared/bot";
import { defaultGroupName, GROUP_MAX_BOTS, GROUP_MIN_BOTS, teamProblem } from "../../../shared/group-chat";
import { teamSaveRpc } from "../../../shared/rpc";
import { Avatar } from "../../components/Avatar";
import { Button, Field, Modal, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useStoreDoc } from "../../lib/data";
import { ExtraFolders, FolderInput, folderProblem } from "../folders";

/** Bots to tick, two to six of them; archived bots can't join. */
export function BotPicker({ bots, selected, onChange }: { bots: readonly Bot[]; selected: readonly string[]; onChange: (ids: string[]) => void }) {
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

/**
 * New team (no `team`) or a team's settings: its bots, the one that leads, its name, the folders
 * its sessions work in and the user's instructions for all of them. A change applies to the
 * sessions started after it; the ones already started keep the team as it was.
 */
export function TeamDialog({ team, onClose, onSaved }: { team?: Team; onClose: () => void; onSaved?: (teamId: string) => void }) {
  const doc = useStoreDoc();
  const feedback = useFeedback();
  const all = doc.data?.values.bots ?? [];
  // Archived members stay listed so they can be taken out.
  const bots = all.filter((bot) => !bot.archived || team?.memberIds.includes(bot.id));
  const [selected, setSelected] = useState<string[]>(team ? team.memberIds.filter((id) => all.some((bot) => bot.id === id)) : []);
  const [leaderId, setLeaderId] = useState<string | null>(team?.leaderId ?? null);
  const [name, setName] = useState(team?.name ?? "");
  const [folder, setFolder] = useState(team?.cwd ?? "");
  const [extra, setExtra] = useState<string[]>(team?.extraFolders ?? []);
  const [instructions, setInstructions] = useState(team?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const leader = leaderId && selected.includes(leaderId) ? leaderId : null;
  const problem = teamProblem({ memberIds: selected, leaderId: leader }) ?? folderProblem(folder) ?? (instructions.length > TEAM_INSTRUCTIONS_MAX ? `The instructions can be at most ${TEAM_INSTRUCTIONS_MAX.toLocaleString()} characters.` : null);
  const generated = defaultGroupName(selected.map((id) => bots.find((bot) => bot.id === id)?.name ?? ""));
  const leaderBot = bots.find((bot) => bot.id === leader);
  const save = async () => {
    if (!leader) return;
    setBusy(true);
    try {
      const { teamId } = await rpc(teamSaveRpc, { id: team?.id ?? null, name: name.trim() || null, memberIds: selected, leaderId: leader, instructions, cwd: folder.trim() || null, extraFolders: extra });
      onSaved?.(teamId);
      onClose();
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={team ? `${team.name}: team settings` : "New team"}
      onClose={onClose}
      footer={
        <>
          <span className="hint grow">{selected.length ? (problem ?? `${selected.length} of ${GROUP_MAX_BOTS} bots`) : `Pick ${GROUP_MIN_BOTS} to ${GROUP_MAX_BOTS} bots`}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem} busy={busy} onClick={() => void save()}>
            {team ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="stack">
        {bots.length < GROUP_MIN_BOTS ? <div className="notice warning">A team needs at least two bots. Make another bot first.</div> : null}
        {team ? <div className="notice">Changes apply to the sessions you start from now on. Sessions already started keep the team as it was.</div> : null}
        <Field label="Bots" hint="Give each bot a role in its settings (its title and description): the leader reads them to decide who does what.">
          <BotPicker bots={bots} selected={selected} onChange={setSelected} />
        </Field>
        {selected.length ? (
          <Field
            label="Leader"
            hint={
              leaderBot
                ? `${leaderBot.name} plans each task, hands the pieces to the others with a brief, checks what comes back and gives you the result. The others work only on what ${leaderBot.name} hands them, and ask each other directly when they need something.`
                : "The bot that plans each task and hands out the work."
            }
          >
            <select className="select" value={leader ?? ""} onChange={(event) => setLeaderId(event.target.value || null)}>
              <option value="" disabled>
                Pick the leader
              </option>
              {bots
                .filter((bot) => selected.includes(bot.id))
                .map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        <Field label="Name" hint="You can rename it any time.">
          <input className="input" value={name} placeholder={selected.length ? generated : "Named after its bots"} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label="Instructions"
          hint="What every bot in the team should follow in each session, such as how to check work (run npm test after a change) or what to deliver. The bots' own instructions still apply."
        >
          <textarea className="textarea" rows={5} value={instructions} placeholder="Optional" onChange={(event) => setInstructions(event.target.value)} />
        </Field>
        <Field
          label="Working folder"
          hint="Where every bot works in this team's sessions, like a repo on this computer. Empty: each bot works in its own folder. A session can start in another folder."
          error={folderProblem(folder)}
        >
          <FolderInput value={folder} onChange={setFolder} placeholder="Each bot's own folder" />
        </Field>
        <Field label="Extra folders" hint="More folders every bot can use besides its working folder, like a second repo.">
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <ExtraFolders folders={extra} exclude={folder.trim() ? [folder.trim()] : []} subject="team" onChange={setExtra} />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
