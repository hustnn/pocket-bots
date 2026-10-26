import { useState } from "react";
import type { ChatSnapshot } from "../../../shared/chat-types";
import type { Team } from "../../../shared/bot";
import { teamDeleteRpc, teamSessionRpc } from "../../../shared/rpc";
import { AvatarStack } from "../../components/Avatar";
import { Icon } from "../../components/icons";
import { Button, IconButton, MenuButton, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useAllChats, useGroups, useStoreDoc } from "../../lib/data";
import { navigate } from "../../lib/router";
import { FolderInput, folderName, folderProblem } from "../folders";
import { GroupComposer } from "../group/GroupComposer";
import { groupRowInfo } from "../group/GroupView";
import { TeamDialog } from "./TeamDialogs";

/** Asks before deleting a team with its sessions; true once it's gone. */
export function useDeleteTeam() {
  const feedback = useFeedback();
  const groups = useGroups();
  return async (team: Team): Promise<boolean> => {
    const sessions = (groups.data ?? []).filter((group) => group.teamId === team.id).length;
    const yes = await feedback.confirm({
      title: `Delete ${team.name}?`,
      body: `${sessions ? `Its ${sessions === 1 ? "session goes" : `${sessions} sessions go`} with it. Each bot's side of a session is archived and stays in that bot's chat history. ` : ""}The bots themselves stay.`,
      action: "Delete",
      danger: true,
    });
    if (!yes) return false;
    try {
      await rpc(teamDeleteRpc, { teamId: team.id });
      return true;
    } catch (failure) {
      feedback.error(errorText(failure));
      return false;
    }
  };
}

/**
 * A team's page: who's in it and what it's told, and the composer for a new session. The task
 * typed here starts the session (named after it) and goes in as its first message.
 */
export function TeamView({ teamId }: { teamId: string }) {
  const doc = useStoreDoc();
  const groups = useGroups();
  const allChats = useAllChats();
  const deleteTeam = useDeleteTeam();
  const [editing, setEditing] = useState(false);
  const [changingFolder, setChangingFolder] = useState(false);
  const team = doc.data?.values.teams.find((entry) => entry.id === teamId) ?? null;
  const [folder, setFolder] = useState<string | null>(null);
  if (!team) {
    return <div className="splash">{doc.isPending ? <span className="spinner" /> : <p className="muted">That team no longer exists.</p>}</div>;
  }
  const bots = doc.data?.values.bots ?? [];
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const members = team.memberIds.flatMap((id) => botById.get(id) ?? []);
  const leader = botById.get(team.leaderId);
  const unavailable = team.memberIds.filter((id) => !botById.get(id) || botById.get(id)!.archived);
  // The folder this session works in: the team's, unless changed for it.
  const cwd = folder === null ? team.cwd : folder.trim() || null;
  const chatById = new Map(((allChats.data ?? []) as ChatSnapshot[]).map((chat) => [chat.id, chat]));
  const busy = cwd ? (groups.data ?? []).filter((group) => group.cwd === cwd && groupRowInfo(group, botById, chatById).working) : [];
  const start = async (task: string) => (await rpc(teamSessionRpc, { teamId, task, ...(folder !== null ? { cwd } : {}) })).groupId;
  const others = members.filter((bot) => bot.id !== team.leaderId);
  return (
    <>
      <div className="topbar">
        <IconButton icon="chevronLeft" title="Back" onClick={() => navigate({ page: "home" })} />
        <AvatarStack avatars={members.map((bot) => bot.avatar)} size={26} />
        <div className="title">
          {team.name}
          <span className="subtitle"> · {members.map((bot) => (bot.id === team.leaderId ? `${bot.name} (leader)` : bot.name)).join(", ")}</span>
        </div>
        <IconButton icon="settings" title="Team settings" onClick={() => setEditing(true)} />
        <MenuButton
          title="Team actions"
          entries={[
            { label: "Team settings", icon: "settings", onSelect: () => setEditing(true) },
            "divider",
            { label: "Delete team", icon: "trash", danger: true, onSelect: () => void deleteTeam(team).then((gone) => gone && navigate({ page: "home" })) },
          ]}
        />
      </div>
      <div className="splash">
        <AvatarStack avatars={members.map((bot) => bot.avatar)} size={56} />
        <h1>{team.name}</h1>
        <p className="muted" style={{ maxWidth: 560, margin: 0 }}>
          Give the team a task. {leader ? `${leader.name} plans it, hands the pieces to ${others.map((bot) => bot.name).join(", ") || "the others"}, checks what comes back and replies with the result.` : ""} Each task gets a session of its own, listed under the team.
        </p>
        {unavailable.length ? <div className="notice warning">Some of this team's bots are archived or gone. Change the team in its settings before starting a session.</div> : null}
        {team.instructions.trim() ? (
          <div className="notice" style={{ maxWidth: 560, textAlign: "left", whiteSpace: "pre-wrap" }} title="The team's instructions, which every bot gets in each session">
            {team.instructions.trim()}
          </div>
        ) : null}
        <div className="row small muted" style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <Icon name="folder" size={13} />
          {changingFolder ? (
            <span style={{ minWidth: 320 }}>
              <FolderInput value={folder ?? team.cwd ?? ""} onChange={setFolder} placeholder="Each bot's own folder" />
            </span>
          ) : (
            <span title={cwd ?? undefined}>{cwd ? `Works in ${folderName(cwd)}` : "Each bot works in its own folder"}</span>
          )}
          <Button small onClick={() => setChangingFolder(!changingFolder)}>
            {changingFolder ? "Done" : "Change for this session"}
          </Button>
        </div>
        {folder !== null && folderProblem(folder) ? <div className="notice error">{folderProblem(folder)}</div> : null}
        {busy.length ? (
          <div className="notice warning" style={{ maxWidth: 560 }}>
            {busy.map((group) => group.name).join(", ")} {busy.length === 1 ? "is" : "are"} working in this folder right now. A new session there changes the same files at the same time.
          </div>
        ) : null}
      </div>
      {!unavailable.length ? (
        <GroupComposer
          key={teamId}
          groupId={null}
          start={start}
          draftKey={`team:${teamId}`}
          placeholder={`Give ${team.name} a task · @ to hand it to one bot`}
          members={members}
          replyTo={null}
          onCancelReply={() => undefined}
          onSent={(groupId) => navigate({ page: "group", groupId })}
        />
      ) : null}
      {editing ? <TeamDialog team={team} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
