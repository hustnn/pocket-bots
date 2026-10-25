import { join } from "node:path";
import { recentWork } from "../shared/activity";
import { selectPlaybooks } from "../shared/playbooks";
import type { AppAccount, PromptApp } from "../shared/apps";
import { accounts, catalog, readState } from "./composio";
import { botSkills, composeSystemPrompt, promptSections, type Bot, type Library, type PromptContext } from "../shared/bot";
import { groupPrompt, type GroupLead, type WorkbenchMode } from "../shared/group-chat";
import { linkBotSkills, skillSha } from "./library";
import { injectedMemory, MAIN_MEMORY, memoryFolder, recentLogEntries } from "./memory";

/**
 * The connected apps a bot may use right now (allowed for it and signed in on
 * this host), with their accounts when it picks one of several, and its limits.
 */
async function botApps(bot: Bot): Promise<PromptApp[]> {
  if (bot.apps.length === 0 || !(await readState()).apiKey) return [];
  const connected = (await accounts().catch(() => ({ accounts: [] as AppAccount[] }))).accounts.filter((account) => account.status === "connected");
  const slugs = bot.apps.filter((slug) => connected.some((account) => account.slug === slug));
  if (slugs.length === 0) return [];
  const names = new Map((await catalog().catch(() => ({ apps: [] }))).apps.map((app) => [app.slug, app.name]));
  return slugs.map((slug) => {
    const rule = bot.appRules[slug];
    // A bot kept to one account doesn't pick; the relay fills it in.
    const mine = rule?.account ? [] : connected.filter((account) => account.slug === slug);
    return { name: names.get(slug) ?? slug, accounts: mine.length > 1 ? mine.map((account) => ({ account: account.alias ?? account.id, name: account.name })) : [], tools: rule?.tools ?? "all" };
  });
}

export interface SeatGroupPrompt {
  name: string;
  subAgents?: boolean;
  questionTool?: string;
  lead?: GroupLead;
  workbenchMode?: WorkbenchMode;
}

export interface ChatStart {
  /** The chat's first message, which picks the playbooks. */
  message?: string;
  /**
   * The group chat this chat is the bot's seat in; `subAgents` when the bot's runtime can start sub-agents, `questionTool` its tool for asking the user,
   * `lead` its part when the group has a leader.
   */
  group?: SeatGroupPrompt;
  /** The chat's extra folders, listed in the prompt. */
  folders?: string[];
}

/**
 * Memory and skills live on this host, so only bots running here get them:
 * an agent on another host couldn't read or update the files.
 */
export async function promptContext(bot: Bot, local: boolean, library: Library, start: ChatStart = {}): Promise<PromptContext> {
  // Playbooks live in the settings, so they travel with the bot to any host.
  const playbooks = selectPlaybooks(start.message ?? "", bot.playbooks);
  const group = start.group ? groupPrompt(start.group.name, { subAgents: start.group.subAgents ?? false, ...(start.group.questionTool ? { questionTool: start.group.questionTool } : {}), ...(start.group.lead ? { lead: start.group.lead } : {}), ...(start.group.workbenchMode ? { workbenchMode: start.group.workbenchMode } : {}) }) : null;
  // Connected apps go through this host's relay, so bots on other hosts can't reach them.
  const folders = start.folders ?? [];
  if (!local) return { memory: "", memoryPath: null, recentWork: [], playbooks, group, skills: [], botTools: false, apps: [], folders };
  // Only skills whose SKILL.md is still what the user reviewed.
  const skills: typeof library.skills = [];
  for (const skill of botSkills(bot, library)) {
    if (skill.reviewedSha === undefined || (skill.reviewedSha !== null && (await skillSha(skill.id)) === skill.reviewedSha)) skills.push(skill);
  }
  const paths = await linkBotSkills(
    bot.id,
    skills.map((skill) => skill.id),
  );
  return {
    memory: await injectedMemory(bot.id),
    memoryPath: join(memoryFolder(bot.id), MAIN_MEMORY),
    recentWork: recentWork(await recentLogEntries(bot.id, 3), new Date()),
    playbooks,
    group,
    skills: skills.map((skill) => ({ name: skill.id, description: skill.description, path: paths.get(skill.id)! })),
    // A seat has no setup tools (tools/mcp.ts ownChat), and a led member's is listed only the tools for its piece (ledMember).
    botTools: start.group ? (start.group.lead?.role === "member" ? "led" : "seat") : true,
    apps: await botApps(bot),
    folders,
  };
}

/**
 * The system prompt for a new chat; a group chat's seat names its group. `standingPrompt` is the
 * same without the parts that change from day to day (see promptSections).
 */
export async function systemPrompt({ bot, message, group, folders }: { bot: Bot; message?: string; group?: SeatGroupPrompt; folders?: string[] }, library: Library) {
  const start: ChatStart = { ...(message !== undefined ? { message } : {}), ...(group ? { group } : {}), ...(folders?.length ? { folders } : {}) };
  const context = await promptContext(bot, true, library, start);
  return { systemPrompt: composeSystemPrompt(bot, context), standingPrompt: composeSystemPrompt(bot, context, { volatile: false }), sections: promptSections(bot, context) };
}
