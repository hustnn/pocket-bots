import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "@pocket-bots/runtime";
import type { WireAttachment } from "../shared/attachments";
import { APPS_MCP_NAME } from "../shared/apps";
import { BOT_LABEL, botMcpServers, botSkills, mcpServersRecord, POCKET_LABEL, type Bot, type BotSettingsValues, type Library } from "../shared/bot";
import { QUIET_TOOLS, TOOLS_MCP_NAME } from "../shared/bot-tools";
import { ABSOLUTE_PATH } from "../shared/folder-path";
import { GROUP_LABEL, type GroupLead } from "../shared/group-chat";
import { replyText } from "../shared/reply";
import { expandLearn } from "../shared/skills";
import { splitStandingUpdate } from "../shared/standing-prompt";
import { newUuid } from "../shared/uuid";
import { botDataPath, ensureBotHome } from "./bot-home";
import type { ChatRecord, OutgoingMessage, SpecBuilder } from "./chat-service";
import { RequestError } from "./errors";
import type { PocketHost } from "./host";
import { librarySkillPath } from "./library";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

export interface StartChatInput {
  prompt: string;
  /** Defaults to the first line of the prompt. */
  title?: string;
  labels?: Record<string, string>;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  clientMessageId?: string;
  /** A group chat's seat: the chat gets the group's tools and the group chat section in its prompt. */
  group?: { id: string; name: string };
  /** The folder the chat works in (see workFolder), instead of the bot's own. */
  cwd?: string;
}

/** A path with a leading ~ or ~/ replaced by this computer's home folder. */
function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Where a bot's chats run: its own folder of yours, or its folder in the data directory. Bots
 * saved before ~/ was expanded on save still hold it as typed, so it's expanded here too. A bot on
 * another host keeps its path as it is: that host's home isn't ours.
 */
export function botWorkingFolder(bot: Bot): string {
  const folder = bot.cwd?.trim();
  if (!folder) return botDataPath(bot.id);
  return bot.hostId ? folder : expandHome(folder);
}

/**
 * A folder the user picked for a chat or a group, as the chat stores it: ~/ expanded, resolved,
 * and an existing folder on this computer.
 */
export async function workFolder(raw: string): Promise<string> {
  const expanded = expandHome(raw.trim());
  if (!isAbsolute(expanded)) throw new RequestError("The folder must be an absolute path, like /Users/me/projects/site.");
  const folder = resolve(expanded);
  const found = await stat(folder).catch(() => null);
  if (!found) throw new RequestError(`There's no folder at ${folder}.`);
  if (!found.isDirectory()) throw new RequestError(`${folder} is a file, not a folder.`);
  return folder;
}

/**
 * The bots document about to be saved, with the working folder of every bot whose folder changed
 * (or that is new) checked like a chat's and stored the way a chat would. Other bots are left
 * alone: a folder deleted since they were saved must not block saving something else. A bot on
 * another host is only checked for being an absolute path, and keeps it as typed, since this
 * computer can't tell what's on that host. Throws a RequestError naming the bot.
 */
export async function resolveBotFolders(previous: BotSettingsValues, next: BotSettingsValues): Promise<BotSettingsValues> {
  const before = new Map(previous.bots.map((bot) => [bot.id, bot.cwd]));
  const bots = await Promise.all(
    next.bots.map(async (bot) => {
      if (before.has(bot.id) && before.get(bot.id) === bot.cwd) return bot;
      const given = bot.cwd?.trim();
      if (!given) return bot.cwd === null ? bot : { ...bot, cwd: null };
      try {
        if (bot.hostId) {
          if (!ABSOLUTE_PATH.test(given)) throw new RequestError("The folder must be an absolute path, like /Users/me/projects/site.");
          return { ...bot, cwd: given };
        }
        return { ...bot, cwd: await workFolder(given) };
      } catch (error) {
        if (error instanceof RequestError) throw new RequestError(`${bot.name}: ${error.message}`);
        throw error;
      }
    }),
  );
  return { ...next, bots };
}

/**
 * Folders a bot's chat uses outside its working folder: the skills linked in from the library,
 * and its memory when the chat works in a folder of yours. Without them, Claude Code asks before
 * every skill read and memory update.
 */
function botDirectories(bot: Bot, library: Library, cwd: string): string[] {
  const skills = botSkills(bot, library).map((skill) => librarySkillPath(skill.id));
  const home = botDataPath(bot.id);
  return [...new Set([...skills, ...(cwd !== home ? [home] : [])])];
}

/**
 * Starts a chat for a bot: its system prompt, its folder, and pocket-bots's tools and connected
 * apps. The web UI, routines and other bots' requests all start chats here.
 */
export async function startChat(host: PocketHost, bot: Bot, input: StartChatInput): Promise<string> {
  if (bot.archived) throw new RequestError(`${bot.name} is archived.`);
  await ensureBotHome({ botId: bot.id });
  const chatId = newUuid();
  await host.chats.create(
    {
      id: chatId,
      botId: bot.id,
      provider: bot.provider as ProviderId,
      model: bot.model,
      thinking: bot.thinkingOptionId,
      mode: bot.modeId,
      cwd: input.cwd ?? botWorkingFolder(bot),
      ...(input.title ? { title: input.title } : {}),
      labels: { [POCKET_LABEL]: "1", [BOT_LABEL]: bot.id, ...(input.group ? { [GROUP_LABEL]: input.group.id } : {}), ...input.labels },
    },
    outgoing({ text: input.prompt, ...(input.images ? { images: input.images } : {}), ...(input.attachments ? { attachments: input.attachments } : {}), ...(input.clientMessageId ? { messageId: input.clientMessageId } : {}) }),
  );
  return chatId;
}

/** What a seat's prompt says about its group: its name and, when the group has a leader, the seat's part in it. */
export type SeatGroupLookup = (groupId: string, botId: string) => Promise<{ name: string; lead?: GroupLead } | null>;

/**
 * The session setup for a bot's chat, rebuilt every time its session opens, so a resumed chat
 * gets the bot's current memory, skills, tools and instructions.
 */
export function chatSpecs(host: PocketHost, relay: Relay, seatGroup: SeatGroupLookup): SpecBuilder {
  return async (chat: ChatRecord) => {
    const bot = chat.botId ? await host.bot(chat.botId) : null;
    if (!bot) return { systemPrompt: "", mcpServers: {}, trustedTools: [] };
    const library = await host.library();
    const groupId = chat.labels[GROUP_LABEL] ?? null;
    const group = groupId ? await seatGroup(groupId, bot.id) : null;
    const first = host.chats.items(chat.id, 400).find((item) => item.type === "user_message");
    // The sub-agent section goes to a seat whose runtime can start sub-agents; a runtime's own
    // question tool is named so the bot knows its questions show in the group.
    const capabilities = host.runtimes.get(bot.provider as ProviderId)?.capabilities;
    const subAgents = capabilities?.subAgents ?? false;
    const questionTool = capabilities?.questionTool;
    // The playbooks follow the chat's first message as typed, without a standing-prompt update in front of it.
    const message = first?.type === "user_message" ? splitStandingUpdate(first.text).text : (chat.title ?? "");
    const { systemPrompt: system, standingPrompt } = await systemPrompt({ bot, message, ...(group ? { group: { name: group.name, subAgents, ...(questionTool ? { questionTool } : {}), ...(group.lead ? { lead: group.lead } : {}) } } : {}) }, library);
    const mcpServers: Record<string, import("@pocket-bots/runtime").McpServerConfig> = { ...mcpServersRecord(botMcpServers(bot, library)) };
    const tools = await relay.mountTools(bot.id, chat.id, groupId);
    if (tools) mcpServers[TOOLS_MCP_NAME] = tools;
    const apps = bot.apps.length ? await relay.mountApps(bot.id) : null;
    if (apps) mcpServers[APPS_MCP_NAME] = apps;
    // Our quiet tools (reading, or proposing what the user confirms) run without prompts; asking
    // another bot does too once the user allowed it for this bot.
    const trusted = [...QUIET_TOOLS, ...(bot.contactBots === "allow" ? ["ask_bot"] : [])].map((tool) => `${TOOLS_MCP_NAME}/${tool}`);
    const granted = bot.alwaysAllow.filter((entry) => /^[^/\s]+\/[^/\s]+$/.test(entry) && entry.split("/")[0]! in mcpServers);
    // A seat's standing prompt reaches its resumed session when it changes (see ChatService).
    return { systemPrompt: system, mcpServers, trustedTools: [...trusted, ...granted], hostedMcpServers: tools ? [TOOLS_MCP_NAME] : [], extraDirectories: botDirectories(bot, library, chat.cwd), ...(groupId ? { standingPrompt } : {}) };
  };
}

export interface SendInput {
  text: string;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  messageId?: string;
  /** The bot's words this message replies to, quoted in front of it (Reply). */
  quote?: string;
  /** What happens to a turn that's still running: the message steers it, or interrupts it. */
  activeTurnBehavior: "steer" | "interrupt";
}

/** What the chat receives for a typed message: /learn expands, and attachments alone get a line of text. */
export function outgoingText(text: string): string {
  return expandLearn(text) ?? (text.trim() || "See the attached files.");
}

/** Text attachments go inline; uploaded files by path (the agent runs on this computer). */
function withAttachments(text: string, attachments: readonly WireAttachment[] = []): string {
  const parts = attachments.map((attachment) =>
    attachment.type === "text"
      ? `<attachment name="${attachment.title.replace(/"/g, "'")}">\n${attachment.text}\n</attachment>`
      : `Attached file: ${attachment.path} (${attachment.fileName}, ${attachment.mimeType}, ${attachment.size} bytes)`,
  );
  return parts.length ? `${text}\n\n${parts.join("\n\n")}` : text;
}

export function outgoing(input: Omit<SendInput, "activeTurnBehavior">): OutgoingMessage {
  let text = outgoingText(input.text);
  if (input.quote?.trim()) {
    // A command goes to the agent as typed, so it can't carry a quote in front.
    if (text.trimStart().startsWith("/")) throw new RequestError("A command can't be a reply. Send it without the quote.");
    text = replyText(input.quote, text);
  }
  return {
    text: withAttachments(text, input.attachments),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.messageId ? { clientMessageId: input.messageId } : {}),
  };
}

/** Sends a message to a chat, from the composer or the queue. */
export async function sendToChat(host: PocketHost, chatId: string, input: SendInput): Promise<void> {
  const result = await host.chats.send(chatId, outgoing(input), input.activeTurnBehavior);
  if (!result.ok) throw new Error(result.detail ?? `The message wasn't sent (${result.reason}).`);
}

/** A bot's chats, newest activity first. */
export function listChats(host: PocketHost, botId: string, includeArchived: boolean) {
  return host.chats.list({ labels: { [BOT_LABEL]: botId }, includeArchived });
}

/** Every open bot chat, for the bot list: each bot's chats and status. */
export function listAllChats(host: PocketHost) {
  return host.chats.list({ labels: { [POCKET_LABEL]: "1" }, limit: 1000 });
}
