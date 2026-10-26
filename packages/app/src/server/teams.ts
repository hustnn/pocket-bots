import { defaultGroupName, sessionName, teamProblem } from "../shared/group-chat";
import { newTeamId, type Team } from "../shared/bot";
import { extraFolders, workFolder } from "./chats";
import { RequestError } from "./errors";
import type { GroupChats } from "./groups";
import type { PocketHost } from "./host";

// Teams: bots that work together under one leader, kept in bots.json beside the bots. A team
// holds no conversation itself: each task the user gives it runs in a session, a group chat
// made from the team as it is at that moment (members, leader, instructions, folders), so
// changing the team leaves the sessions already started as they were.

export interface TeamInput {
  /** The team to change; left out, a new one. */
  id?: string | null;
  name?: string | null;
  memberIds: string[];
  leaderId: string;
  instructions?: string;
  cwd?: string | null;
  extraFolders?: string[];
}

export class Teams {
  constructor(
    private readonly host: PocketHost,
    private readonly groups: GroupChats,
  ) {}

  async list(): Promise<Team[]> {
    return (await this.host.store.values()).teams;
  }

  async get(teamId: string): Promise<Team> {
    const team = (await this.list()).find((entry) => entry.id === teamId);
    if (!team) throw new RequestError(`There's no team with the id ${teamId}.`);
    return team;
  }

  /**
   * Creates or changes a team. Its bots must exist and not be archived; its folders are checked
   * like a group's. Without a name, it's named after its bots.
   */
  async save(input: TeamInput): Promise<{ teamId: string }> {
    const memberIds = [...new Set(input.memberIds)];
    const problem = teamProblem({ memberIds, leaderId: input.leaderId });
    if (problem) throw new RequestError(problem);
    const bots = new Map((await this.host.bots()).map((bot) => [bot.id, bot]));
    for (const botId of memberIds) {
      const bot = bots.get(botId);
      if (!bot) throw new RequestError(`There's no bot with the id ${botId}.`);
      if (bot.archived) throw new RequestError(`${bot.name} is archived: unarchive it before it joins a team.`);
    }
    const cwd = input.cwd?.trim() ? await workFolder(input.cwd) : null;
    const folders = input.extraFolders?.length ? await extraFolders(input.extraFolders, cwd) : [];
    const at = new Date().toISOString();
    const teamId = input.id ?? newTeamId();
    const fields = {
      name: input.name?.trim() || defaultGroupName(memberIds.map((botId) => bots.get(botId)!.name)),
      memberIds,
      leaderId: input.leaderId,
      instructions: (input.instructions ?? "").trimEnd(),
      cwd,
      extraFolders: folders,
    };
    await this.host.store.update((values) => {
      const current = values.teams.find((team) => team.id === teamId);
      if (input.id && !current) throw new RequestError(`There's no team with the id ${input.id}.`);
      const team: Team = { id: teamId, ...fields, createdAt: current?.createdAt ?? at, updatedAt: at };
      return { ...values, teams: current ? values.teams.map((entry) => (entry.id === teamId ? team : entry)) : [...values.teams, team] };
    });
    return { teamId };
  }

  /** Deletes a team and its sessions; the bots stay, and each one's side of a session is archived. */
  async remove(teamId: string): Promise<void> {
    await this.get(teamId);
    for (const groupId of this.groups.teamSessions(teamId)) await this.groups.remove(groupId);
    await this.host.store.update((values) => ({ ...values, teams: values.teams.filter((team) => team.id !== teamId) }));
  }

  /**
   * A new session of a team for a task, named after it. It works in the team's folder, or in
   * `cwd` when given (null: each bot's own folder).
   */
  async startSession(teamId: string, input: { task: string; cwd?: string | null }): Promise<{ groupId: string }> {
    const team = await this.get(teamId);
    const bots = new Map((await this.host.bots()).map((bot) => [bot.id, bot]));
    for (const botId of team.memberIds) {
      const bot = bots.get(botId);
      if (!bot) throw new RequestError(`One of ${team.name}'s bots no longer exists: edit the team first.`);
      if (bot.archived) throw new RequestError(`${bot.name} is archived: unarchive it, or take it out of ${team.name}.`);
    }
    const cwd = input.cwd === undefined ? team.cwd : input.cwd;
    const { id } = await this.groups.create({
      name: sessionName(input.task),
      memberIds: team.memberIds,
      leaderId: team.leaderId,
      cwd,
      extraFolders: team.extraFolders,
      teamId: team.id,
      instructions: team.instructions,
    });
    return { groupId: id };
  }
}
