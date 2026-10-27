import { resolve } from "node:path";
import type { PocketHost } from "../host";
import { z } from "zod";
import { foldText, lastTurn } from "../../shared/activity";
import { BOT_LABEL } from "../../shared/bot";
import { answerPrompt, askPrompt, failurePrompt } from "../../shared/peers";
import { botDataPath } from "../bot-home";
import { startChat } from "../chats";
import { defineTool, type ToolCaller } from "./mcp";

// Other bots on this host: who they are, so a bot can hand work to the right one.

export const listBots = defineTool({
  name: "list_bots",
  description: "List the other bots on this computer: id, name, what each does. Use it before asking another bot for help.",
  input: z.object({}),
  async run(_args, { bot, host }) {
    const others = (await host.bots()).filter((entry) => entry.id !== bot.id && !entry.archived);
    if (others.length === 0) return "There are no other bots.";
    return others
      .map((entry) => {
        const about = [entry.title, entry.description].filter((part) => part.trim()).join(" — ");
        return `- ${entry.name} (id: ${entry.id})${about ? `: ${about}` : ""}`;
      })
      .join("\n");
  },
});

/** Label on a chat started by another bot's ask_bot, carrying the asking bot's id. */
export const ASKED_BY_LABEL = "pocket-bots.asked-by";
/** MCP clients give up on a tool call after about a minute (Codex after 60 seconds), so answers are awaited a little less. */
const ASK_WAIT_MS = 50_000;
const REPLY_MAX = 8_000;

export interface ChatState {
  title: string;
  state: "running" | "permission" | "error" | "idle";
  error: string | null;
  reply: string;
}

export async function readChat(host: PocketHost, chatId: string): Promise<ChatState & { labels: Record<string, string> }> {
  const agent = host.chats.get(chatId);
  if (!agent) throw new Error("There's no chat with that id.");
  const items = host.chats.items(chatId, 80);
  const busy = agent.status === "running" || agent.status === "initializing";
  return {
    title: agent.title ?? "Untitled chat",
    labels: agent.labels ?? {},
    state: agent.pendingPermissions?.length ? "permission" : busy ? "running" : agent.status === "error" ? "error" : "idle",
    error: agent.lastError ?? null,
    reply: lastTurn(items as { type: string; text?: unknown; name?: unknown }[]).reply,
  };
}

const cut = (reply: string) => (reply.length > REPLY_MAX ? `${reply.slice(0, REPLY_MAX)}\n[cut at ${REPLY_MAX} characters]` : reply);

/** What the tool says about a chat; `followUp` when its answer will be sent to the asking chat on its own. */
function describeChat(chat: ChatState, who: string, chatId: string, followUp = false): string {
  switch (chat.state) {
    case "running":
      return followUp
        ? `${who} is still working in chat ${chatId}. Its answer will be sent to this chat on its own when it's done, so there's no need to keep checking: tell the user it's on its way, and carry on with anything else.`
        : `${who} is still working in chat ${chatId}. Use check_chat with that id for the answer.`;
    case "permission":
      return followUp
        ? `${who} is waiting for the user to approve something in chat ${chatId}. Tell the user; its answer will be sent to this chat when it's done.`
        : `${who} is waiting for the user to approve something in chat ${chatId}. Tell the user, and use check_chat with that id later.`;
    case "error":
      return `${who}'s chat ${chatId} stopped with an error: ${chat.error ?? "unknown error"}`;
    case "idle":
      return chat.reply.trim() ? `${who} answered (chat ${chatId}):\n\n${cut(chat.reply)}` : `${who} finished in chat ${chatId} without a reply.`;
  }
}

/** The message an asking chat gets when an answer it was told to expect is ready. */
export function answerMessage(chat: ChatState, who: string, chatId: string): string {
  if (chat.state === "error") return failurePrompt(who, chatId, chat.error ?? "Unknown error.");
  return answerPrompt(who, chatId, chat.reply.trim() ? cut(chat.reply) : `${who} finished without a reply.`);
}

/**
 * An asked chat's state for the bot that asked, after waiting for it when `wait`.
 * One still working owes its answer to the asking chat, which gets it on its own later.
 * From then on a look doesn't wait again: the turn needn't hold on for an answer that's coming anyway.
 */
async function lookAtAsked(caller: ToolCaller, chatId: string, wait: boolean): Promise<{ chat: ChatState & { labels: Record<string, string> }; followUp: boolean }> {
  const { answers, host } = caller;
  const waitFor = wait && !(await answers?.owes(chatId));
  const look = async () => {
    if (waitFor) await host.chats.waitForFinish(chatId, ASK_WAIT_MS);
    return readChat(host, chatId);
  };
  if (!answers) return { chat: await look(), followUp: false };
  const chat = await answers.waiting(chatId, look);
  if (chat.state === "running" || chat.state === "permission") {
    await answers.owe(chatId, caller.agentId);
    return { chat, followUp: true };
  }
  await answers.received(chatId);
  return { chat, followUp: false };
}

/** Bots answering another bot don't ask further, so requests can't loop. */
async function mayAsk({ bot, agentId, host }: ToolCaller): Promise<boolean> {
  if (bot.contactBots === "off") return false;
  const chat = await host.chatOf(agentId);
  return !chat?.labels[ASKED_BY_LABEL];
}

/**
 * The folder the asking chat works in, for the asked bot's chat. Never the asker's own bot folder:
 * that holds its memory and other chats' files, which the other bot has no business reading.
 */
function askerFolder({ bot, agentId, host }: ToolCaller): string {
  const cwd = host.chats.get(agentId)?.cwd;
  if (!cwd) throw new Error("This chat's folder isn't known, so in_my_folder can't be used here.");
  if (resolve(cwd) === resolve(botDataPath(bot.id))) throw new Error("This chat works in your own bot folder, not a project, so in_my_folder can't be used. Ask without it, and give the other bot absolute paths.");
  return cwd;
}

export const askBot = defineTool({
  name: "ask_bot",
  description:
    "Ask another bot on this computer for help. It gets your message in a new chat of its own, works with its own tools and settings, and its answer comes back here: in this call when it's quick, otherwise as a message in this chat once it's done. Use list_bots to see who does what.",
  input: z.object({
    bot: z.string().min(1).max(100).describe("The other bot's name or id."),
    message: z.string().min(1).max(20_000).describe("What you need, written so the other bot can act on it without this chat."),
    wait: z.boolean().optional().describe("Wait up to about 50 seconds for the answer (the default). With false, return at once; the answer comes to this chat when it's done."),
    in_my_folder: z.boolean().optional().describe("Start its chat in the folder this chat works in (a project of the user's), so it can read and search the files there by relative path, as for a review of them. Off by default: it works in its own folder."),
  }),
  available: mayAsk,
  async run({ bot: wanted, message, wait = true, in_my_folder: inMyFolder = false }, caller) {
    const { bot, host } = caller;
    const others = (await host.bots()).filter((entry) => entry.id !== bot.id && !entry.archived);
    const key = wanted.trim().toLowerCase();
    const target = others.find((entry) => entry.id === wanted.trim()) ?? others.find((entry) => entry.name.trim().toLowerCase() === key);
    if (!target) throw new Error(others.length ? `There's no other bot called "${wanted}". Ask one of: ${others.map((entry) => entry.name).join(", ")}.` : "There are no other bots to ask.");
    const cwd = inMyFolder ? askerFolder(caller) : undefined;
    const chatId = await startChat(host, target, { prompt: askPrompt(bot.name, message), title: `${bot.name}: ${foldText(message, 60)}`, labels: { [ASKED_BY_LABEL]: bot.id }, ...(cwd ? { cwd } : {}) });
    if (!wait) {
      if (!caller.answers) return `Asked ${target.name} in chat ${chatId}. Use check_chat with that id for the answer.`;
      await caller.answers.owe(chatId, caller.agentId);
      return `Asked ${target.name} in chat ${chatId}. Its answer will be sent to this chat on its own when it's done; use check_chat with that id only if you need it sooner.`;
    }
    const { chat, followUp } = await lookAtAsked(caller, chatId, true);
    return describeChat(chat, target.name, chatId, followUp);
  },
});

export const checkChat = defineTool({
  name: "check_chat",
  description: "Check a chat you started with ask_bot (or one of your own chats): whether it's still working, and its latest answer.",
  input: z.object({
    chat_id: z.string().min(1).max(100).describe("The chat id ask_bot or search_chats gave you."),
    wait: z.boolean().optional().describe("If it's still working, wait up to about 50 seconds for it to finish. An answer that's already coming to this chat on its own isn't waited for."),
  }),
  async run({ chat_id, wait = false }, caller) {
    const { bot, host } = caller;
    const chatId = chat_id.trim();
    let chat = await readChat(host, chatId);
    const owner = chat.labels[BOT_LABEL];
    let followUp = false;
    if (owner === bot.id) {
      if (wait && chat.state === "running") {
        await host.chats.waitForFinish(chatId, ASK_WAIT_MS);
        chat = await readChat(host, chatId);
      }
    } else if (chat.labels[ASKED_BY_LABEL] === bot.id) {
      ({ chat, followUp } = await lookAtAsked(caller, chatId, wait && chat.state === "running"));
    } else {
      throw new Error("You can only check your own chats and ones you started with ask_bot.");
    }
    const who = owner === bot.id ? "You" : ((await host.bot(owner ?? ""))?.name ?? "The other bot");
    return `"${chat.title}": ${describeChat(chat, who, chatId, followUp)}`;
  },
});
