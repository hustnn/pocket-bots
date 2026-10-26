// Teams and their sessions: saving a team checks its bots, leader and folders; a session copies
// the team as it is when it starts (members, leader, instructions, folders); the instructions
// reach every seat's prompt; deleting a team deletes its sessions.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/server/db";
import { GroupStore } from "../src/server/group-store";
import { GroupChats } from "../src/server/groups";
import { Teams } from "../src/server/teams";
import { groupPrompt, sessionName, teamProblem } from "../src/shared/group-chat";
import { fakeHost, makeBot, type FakeHost } from "./helpers";

let dir: string;
let db: Db;
let host: FakeHost;
let groups: GroupChats;
let teams: Teams;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bots-teams-"));
  db = new Db(join(dir, "bots.sqlite"));
  host = fakeHost([
    makeBot({ id: "lena", name: "Lena", title: "Tech lead" }),
    makeBot({ id: "dev", name: "Dev", title: "Developer" }),
    makeBot({ id: "quinn", name: "Quinn", title: "QA" }),
    makeBot({ id: "old", name: "Old", archived: true }),
  ]);
  groups = new GroupChats(host, new GroupStore(db), async () => "never");
  teams = new Teams(host, groups);
});

afterEach(async () => {
  groups.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("team rules", () => {
  it("needs two to six bots and a leader among them", () => {
    expect(teamProblem({ memberIds: ["lena"], leaderId: "lena" })).toBe("A team needs at least 2 bots.");
    expect(teamProblem({ memberIds: ["a", "b", "c", "d", "e", "f", "g"], leaderId: "a" })).toBe("A team can have at most 6 bots.");
    expect(teamProblem({ memberIds: ["lena", "dev"], leaderId: null })).toBe("Pick the bot that leads the team.");
    expect(teamProblem({ memberIds: ["lena", "dev"], leaderId: "quinn" })).toBe("The leader must be one of the team's bots.");
    expect(teamProblem({ memberIds: ["lena", "dev"], leaderId: "lena" })).toBeNull();
  });

  it("names a session after the start of its task", () => {
    expect(sessionName("  Add a --version flag\nto the CLI ")).toBe("Add a --version flag to the CLI");
    expect(sessionName("x".repeat(80))).toBe(`${"x".repeat(57)}…`);
    expect(sessionName("   ")).toBe("New session");
  });
});

describe("saving a team", () => {
  it("refuses bots that are archived or don't exist, and a leader outside the team", async () => {
    await expect(teams.save({ memberIds: ["lena", "old"], leaderId: "lena" })).rejects.toThrow("Old is archived");
    await expect(teams.save({ memberIds: ["lena", "ghost"], leaderId: "lena" })).rejects.toThrow("There's no bot with the id ghost.");
    await expect(teams.save({ memberIds: ["lena", "dev"], leaderId: "quinn" })).rejects.toThrow("The leader must be one of the team's bots.");
    await expect(teams.save({ memberIds: ["lena", "dev"], leaderId: "lena", cwd: join(dir, "missing") })).rejects.toThrow("There's no folder at");
    expect(await teams.list()).toEqual([]);
  });

  it("is named after its bots without a name, and a change keeps when it was made", async () => {
    const { teamId } = await teams.save({ memberIds: ["lena", "dev", "quinn"], leaderId: "lena", instructions: "Run npm test.\n\n" });
    const made = await teams.get(teamId);
    expect(made).toMatchObject({ name: "Lena, Dev & Quinn", memberIds: ["lena", "dev", "quinn"], leaderId: "lena", instructions: "Run npm test.", cwd: null, extraFolders: [] });
    await teams.save({ id: teamId, name: "Pocket dev", memberIds: ["lena", "dev"], leaderId: "dev", cwd: dir });
    expect(await teams.list()).toHaveLength(1);
    expect(await teams.get(teamId)).toMatchObject({ name: "Pocket dev", memberIds: ["lena", "dev"], leaderId: "dev", instructions: "", cwd: dir, createdAt: made.createdAt });
    await expect(teams.save({ id: "team-gone", memberIds: ["lena", "dev"], leaderId: "lena" })).rejects.toThrow("There's no team with the id team-gone.");
  });
});

describe("a team's sessions", () => {
  it("copy the team as it is when they start, and every seat gets its instructions", async () => {
    const { teamId } = await teams.save({ name: "Pocket dev", memberIds: ["lena", "dev", "quinn"], leaderId: "lena", instructions: "Run npm test after every change.", cwd: dir });
    const { groupId } = await teams.startSession(teamId, { task: "Add a --version flag to the CLI." });
    const [session] = (await groups.list()).filter((group) => group.id === groupId);
    expect(session).toMatchObject({ name: "Add a --version flag to the CLI.", teamId, memberIds: ["lena", "dev", "quinn"], leaderId: "lena", cwd: dir });
    const leader = await groups.seatGroup(groupId, "lena");
    const member = await groups.seatGroup(groupId, "dev");
    expect(leader).toMatchObject({ instructions: "Run npm test after every change.", lead: { role: "leader" } });
    expect(member).toMatchObject({ instructions: "Run npm test after every change.", lead: { role: "member", leader: "Lena" } });
    expect(groupPrompt(session!.name, { lead: member!.lead!, instructions: member!.instructions! })).toContain("The user's instructions for everyone in this team:\nRun npm test after every change.");

    // A change to the team is for the sessions started after it.
    await teams.save({ id: teamId, name: "Pocket dev", memberIds: ["lena", "dev"], leaderId: "dev", instructions: "Keep diffs small." });
    expect(await groups.seatGroup(groupId, "dev")).toMatchObject({ instructions: "Run npm test after every change.", lead: { role: "member", leader: "Lena" } });
    const next = await teams.startSession(teamId, { task: "Fix the flaky test." });
    expect((await groups.list()).find((group) => group.id === next.groupId)).toMatchObject({ memberIds: ["lena", "dev"], leaderId: "dev", cwd: null });
    expect(await groups.seatGroup(next.groupId, "lena")).toMatchObject({ instructions: "Keep diffs small.", lead: { role: "member", leader: "Dev" } });
    expect(groups.teamSessions(teamId).sort()).toEqual([groupId, next.groupId].sort());
  });

  it("work in another folder when the session says so, and a group made on its own has no instructions", async () => {
    const other = await mkdtemp(join(tmpdir(), "bots-teams-other-"));
    try {
      const { teamId } = await teams.save({ memberIds: ["lena", "dev"], leaderId: "lena", cwd: dir });
      const moved = await teams.startSession(teamId, { task: "Elsewhere", cwd: other });
      const own = await teams.startSession(teamId, { task: "Their own folders", cwd: null });
      const list = await groups.list();
      expect(list.find((group) => group.id === moved.groupId)?.cwd).toBe(other);
      expect(list.find((group) => group.id === own.groupId)?.cwd).toBeNull();
      const { id } = await groups.create({ name: "Plain", memberIds: ["lena", "dev"] });
      expect(await groups.seatGroup(id, "dev")).toEqual({ name: "Plain" });
      expect(list.find((group) => group.id === moved.groupId)?.teamId).toBe(teamId);
      expect((await groups.list()).find((group) => group.id === id)?.teamId).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("can't start while one of the team's bots is archived", async () => {
    const { teamId } = await teams.save({ memberIds: ["lena", "dev"], leaderId: "lena" });
    (await host.values()).bots.find((bot) => bot.id === "dev")!.archived = true;
    await expect(teams.startSession(teamId, { task: "Anything" })).rejects.toThrow("Dev is archived");
  });

  it("go when their team is deleted", async () => {
    const { teamId } = await teams.save({ memberIds: ["lena", "dev"], leaderId: "lena" });
    const other = await teams.save({ memberIds: ["dev", "quinn"], leaderId: "quinn" });
    await teams.startSession(teamId, { task: "One" });
    await teams.startSession(teamId, { task: "Two" });
    const kept = await teams.startSession(other.teamId, { task: "Three" });
    await teams.remove(teamId);
    expect((await groups.list()).map((group) => group.id)).toEqual([kept.groupId]);
    expect((await teams.list()).map((team) => team.id)).toEqual([other.teamId]);
    await expect(teams.remove(teamId)).rejects.toThrow("There's no team");
  });
});
