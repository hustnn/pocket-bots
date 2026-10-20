import type { z } from "zod";
import { applyChanges } from "../shared/changes";
import { BOT_LABEL, EMPTY_LIBRARY, newRoutineId } from "../shared/bot";
import { GROUP_LABEL } from "../shared/group-chat";
import { setBotUses, updateSkill, upsertSkills } from "../shared/library";
import type { RpcContract } from "../shared/rpc-core";
import * as rpc from "../shared/rpc";
import { chatTranscript } from "../shared/transcript";
import { POCKET_VERSION } from "../shared/version";
import { dataPath, ensureBotHome } from "./bot-home";
import type { ChatCards } from "./cards";
import { botWorkingFolder, extraFolders, listAllChats, listChats, sendToChat, startChat, workFolder } from "./chats";
import type { CommandAllowlist, FolderGrants } from "./commands";
import { accounts, appTools, catalog, connect, disconnect, removeKey, renameAccount, setKey, status as appsStatus } from "./composio";
import { RequestError } from "./errors";
import { groupFilesPath, type GroupChats } from "./groups";
import type { PocketHost } from "./host";
import { generateAvatar, imageStatus, removeImageKey, setImageKey } from "./images";
import type { MemoryJournal } from "./journal";
import { deleteSkill, importSkills, readSkill, writeSkill } from "./library";
import { probeMcpServer } from "./mcp-probe";
import { mcpSources } from "./mcp-sources";
import { deleteLogDay, listLogDays, listMemory, readLogDay, readMemory } from "./memory";
import { systemPrompt } from "./prompt";
import { acceptProposal, dismissProposal, getProposal } from "./proposals";
import type { MessageQueue } from "./queue";
import type { Relay } from "./relay";
import type { RoutineScheduler } from "./scheduler";
import { searchMessages } from "./search";
import { exportBot, exportBots, importBot, importBots } from "./share";
import type { Store } from "./store";
import { saveFile, saveUpload } from "./uploads";

export interface Services {
  store: Store;
  host: PocketHost;
  relay: Relay;
  scheduler: RoutineScheduler;
  journal: MemoryJournal;
  commands: CommandAllowlist;
  folders: FolderGrants;
  cards: ChatCards;
  queue: MessageQueue;
  groups: GroupChats;
}

type Handler<C extends RpcContract> = (input: z.output<C["input"]>) => z.input<C["output"]> | Promise<z.input<C["output"]>>;

export interface RpcRegistration {
  contract: RpcContract;
  handler: (input: unknown) => unknown;
}

/** Every RPC the web UI can call, by name. */
export function rpcHandlers(services: Services): Map<string, RpcRegistration> {
  const { store, host, scheduler, journal, commands, folders, cards, queue, groups } = services;
  const registry = new Map<string, RpcRegistration>();
  const handle = <C extends RpcContract>(contract: C, handler: Handler<C>) => {
    registry.set(contract.name, { contract, handler: handler as (input: unknown) => unknown });
  };
  const library = async () => (await store.values()).library ?? EMPTY_LIBRARY;

  // ------------------------------------------------------------ store and status

  handle(rpc.storeGetRpc, async () => store.read());
  handle(rpc.storeSaveRpc, ({ values, revision }) => store.save(values, revision));
  handle(rpc.storeResetRpc, () => store.reset());
  handle(rpc.statusRpc, () => ({ version: POCKET_VERSION, dataPath: dataPath(), scheduler: scheduler.running }));
  handle(rpc.providersRpc, ({ refresh }) => host.providers.snapshot(refresh ?? false));
  handle(rpc.workspacesRpc, async () => {
    // Folders bots, groups and recent chats already work in; pocket-bots's own bot folders aren't
    // somewhere to point a bot at.
    const own = dataPath();
    const seen = new Set<string>();
    const workspaces: { id: string; directory: string }[] = [];
    const add = (directory: string | null) => {
      if (!directory || seen.has(directory) || directory.startsWith(own)) return;
      seen.add(directory);
      workspaces.push({ id: directory, directory });
    };
    for (const bot of await host.bots()) add(bot.cwd);
    for (const group of await groups.list()) for (const directory of [group.cwd, ...group.extraFolders]) add(directory);
    for (const chat of listAllChats(host).slice(0, 200)) for (const directory of [chat.cwd, ...chat.extraFolders]) add(directory);
    return { workspaces };
  });

  // ------------------------------------------------------------ chats

  handle(rpc.chatsListRpc, ({ botId, includeArchived }) => ({ chats: listChats(host, botId, includeArchived ?? false) }));
  handle(rpc.chatsAllRpc, () => ({ chats: listAllChats(host) }));
  handle(rpc.chatGetRpc, ({ chatId }) => ({ agent: host.chats.get(chatId) }));
  handle(rpc.chatTimelineRpc, ({ chatId, direction, cursor, limit }) => host.chats.timeline(chatId, { direction, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) }));
  handle(rpc.chatStartRpc, async ({ botId, text, images, attachments, messageId, cwd, extraFolders: extra }) => {
    const bot = await host.bot(botId);
    if (!bot) throw new RequestError("That bot no longer exists.");
    const folder = cwd?.trim() ? await workFolder(cwd) : null;
    const folders = extra?.length ? await extraFolders(extra, folder ?? botWorkingFolder(bot)) : [];
    const chatId = await startChat(host, bot, { prompt: text, images, attachments, ...(messageId ? { clientMessageId: messageId } : {}), ...(folder ? { cwd: folder } : {}), ...(folders.length ? { extraFolders: folders } : {}) });
    return { chatId };
  });
  handle(rpc.chatFoldersRpc, async ({ chatId, extraFolders: raw }) => {
    const chat = host.chats.get(chatId);
    if (!chat) throw new RequestError("There's no chat with that id.");
    if (chat.labels[GROUP_LABEL]) throw new RequestError("A group chat's folders are changed in the group.");
    const folders = await extraFolders(raw, chat.cwd);
    await host.chats.setExtraFolders(chatId, folders);
    return { extraFolders: folders };
  });
  handle(rpc.chatSendRpc, async ({ chatId, text, images, attachments, messageId, quote, activeTurnBehavior }) => {
    await sendToChat(host, chatId, { text, images, attachments, activeTurnBehavior: activeTurnBehavior ?? "steer", ...(messageId ? { messageId } : {}), ...(quote ? { quote } : {}) });
    return { ok: true };
  });
  handle(rpc.chatStopRpc, async ({ chatId }) => ({ ok: await host.chats.interrupt(chatId) }));
  handle(rpc.chatRespondRpc, async ({ chatId, requestId, response }) => {
    const answered = await host.chats.respond(chatId, requestId, response);
    if (response.behavior === "deny" && response.interrupt) await host.chats.interrupt(chatId);
    return { ok: answered };
  });
  handle(rpc.chatArchiveRpc, async ({ chatId }) => {
    await host.chats.archive(chatId);
    return { ok: true };
  });
  handle(rpc.chatTranscriptRpc, async ({ chatId }) => {
    const agent = host.chats.get(chatId);
    if (!agent) throw new RequestError("There's no chat with that id.");
    const entries: { item: { type: string }; timestamp: string }[] = [];
    let page = host.chats.timeline(chatId, { direction: "tail", limit: 500 });
    entries.unshift(...page.entries);
    for (let pages = 0; pages < 50 && page.hasOlder && page.startCursor; pages++) {
      page = host.chats.timeline(chatId, { direction: "before", cursor: page.startCursor, limit: 500 });
      entries.unshift(...page.entries);
    }
    const botId = agent.labels[BOT_LABEL];
    const bot = botId ? await host.bot(botId) : null;
    const title = agent.title?.trim() || "Untitled chat";
    return { title, markdown: chatTranscript({ title, botName: bot?.name ?? "Bot", entries, exportedAt: new Date() }) };
  });
  handle(rpc.chatCardsRpc, async ({ chatId }) => ({ cards: await cards.list(chatId) }));
  handle(rpc.chatCommandsRpc, async ({ chatId }) => {
    try {
      return { commands: await host.chats.commands(chatId), error: null };
    } catch (error) {
      return { commands: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  handle(rpc.queueListRpc, ({ chatId }) => queue.list(chatId));
  handle(rpc.queueAddRpc, async ({ chatId, text, attachments, quote }) => ({ id: await queue.add(chatId, { text, attachments, ...(quote ? { quote } : {}) }) }));
  handle(rpc.searchRpc, async ({ query, chatId, groupId, limit }) => ({ hits: await searchMessages(host, groups, { query, ...(chatId ? { chatId } : {}), ...(groupId ? { groupId } : {}), ...(limit ? { limit } : {}) }) }));
  handle(rpc.queueTakeRpc, async ({ chatId, id }) => ({ message: await queue.take(chatId, id) }));
  handle(rpc.queueSendNowRpc, async ({ chatId, id, activeTurnBehavior }) => {
    await queue.sendNow(chatId, id, activeTurnBehavior);
    return { ok: true };
  });
  handle(rpc.queueResumeRpc, async ({ chatId }) => {
    await queue.resume(chatId);
    return { ok: true };
  });

  // ------------------------------------------------------------ bots, memory and skills

  handle(rpc.ensureBotHomeRpc, (input) => ensureBotHome(input));
  handle(rpc.systemPromptRpc, async (input) => systemPrompt(input, await library()));
  handle(rpc.memoryListRpc, ({ botId }) => listMemory(botId));
  handle(rpc.memoryReadRpc, ({ botId, name }) => readMemory(botId, name));
  handle(rpc.memoryWriteRpc, async ({ botId, name, text }) => {
    await journal.write(botId, name, text);
    return { ok: true };
  });
  handle(rpc.memoryDeleteRpc, async ({ botId, name }) => {
    await journal.write(botId, name, null);
    return { ok: true };
  });
  handle(rpc.memoryJournalRpc, async ({ botId }) => ({
    entries: (await journal.list(botId)).map(({ before, ...entry }) => ({ ...entry, canUndo: entry.kind === "created" || before !== null })),
  }));
  handle(rpc.memoryUndoRpc, async ({ botId, id }) => {
    await journal.undo(botId, id);
    return { ok: true };
  });
  handle(rpc.memoryLogRpc, async ({ botId, day }) => ({ ...(await listLogDays(botId)), text: day ? (await readLogDay(botId, day)).text : null }));
  handle(rpc.memoryLogDeleteRpc, ({ botId, day }) => deleteLogDay(botId, day));
  handle(rpc.skillImportRpc, importSkills);
  handle(rpc.skillReadRpc, readSkill);
  handle(rpc.skillWriteRpc, writeSkill);
  handle(rpc.skillDeleteRpc, deleteSkill);
  handle(rpc.mcpProbeRpc, probeMcpServer);
  handle(rpc.mcpSourcesRpc, () => mcpSources());
  handle(rpc.uploadRpc, saveUpload);
  handle(rpc.exportBotRpc, async (input) => exportBot(input, await library()));
  handle(rpc.importBotRpc, importBot);
  handle(rpc.exportBotsRpc, async (input) => exportBots(input, await library()));
  handle(rpc.importBotsRpc, importBots);

  // ------------------------------------------------------------ group chats

  handle(rpc.groupsListRpc, async () => ({ groups: await groups.list() }));
  handle(rpc.groupCreateRpc, async ({ name, memberIds, leaderId, cwd, extraFolders }) => ({ groupId: (await groups.create({ name: name ?? null, memberIds, leaderId: leaderId ?? null, cwd: cwd ?? null, ...(extraFolders ? { extraFolders } : {}) })).id }));
  handle(rpc.groupUpdateRpc, async ({ groupId, name, memberIds, wakeMode, leaderId, cwd, extraFolders }) => {
    await groups.update(groupId, { name: name ?? null, memberIds: memberIds ?? null, wakeMode: wakeMode ?? null, ...(leaderId !== undefined ? { leaderId } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(extraFolders !== undefined ? { extraFolders } : {}) });
    return { ok: true };
  });
  handle(rpc.groupTaskRpc, async ({ groupId, action, seq, number, status, assignee, title, description }) => {
    await groups.userTask(groupId, { action, seq: seq ?? null, number: number ?? null, status: status ?? null, assignee: assignee ?? null, title: title ?? null, ...(description !== undefined ? { description } : {}) });
    return { ok: true };
  });
  handle(rpc.groupTasksRpc, async ({ groupId }) => ({ tasks: await groups.listTasks(groupId) }));
  handle(rpc.groupRemindersRpc, async ({ groupId }) => ({ reminders: await groups.listReminders(groupId) }));
  handle(rpc.groupReactRpc, async ({ groupId, seq, emoji }) => {
    await groups.userReact(groupId, seq, emoji);
    return { ok: true };
  });
  handle(rpc.groupAnswerRpc, async ({ groupId, seq, response }) => {
    await groups.answer(groupId, seq, response);
    return { ok: true };
  });
  handle(rpc.groupSearchRpc, async ({ groupId, query }) => ({ messages: await groups.searchMessages(groupId, query) }));
  handle(rpc.groupMuteRpc, async ({ groupId, botId, muted }) => {
    await groups.setMuted(groupId, botId, muted);
    return { ok: true };
  });
  handle(rpc.groupDeleteRpc, async ({ groupId }) => {
    await groups.remove(groupId);
    return { ok: true };
  });
  handle(rpc.groupMessagesRpc, ({ groupId, before, limit, thread }) => groups.messages(groupId, { before: before ?? null, thread: thread ?? null, ...(limit ? { limit } : {}) }));
  handle(rpc.groupSendRpc, async ({ groupId, text, replyTo, thread, attachments, asTask }) => ({ seq: await groups.postFromUser(groupId, { text, replyTo: replyTo ?? null, thread: thread ?? null, attachments, asTask: asTask ?? false }) }));
  handle(rpc.groupReadRpc, async ({ groupId, seq, thread }) => {
    await groups.markRead(groupId, seq, thread ?? null);
    return { ok: true };
  });
  handle(rpc.groupUploadRpc, ({ groupId, fileName, dataBase64 }) => saveFile(groupFilesPath(groupId), fileName, dataBase64));

  // ------------------------------------------------------------ avatars and connected apps

  handle(rpc.avatarKeyStatusRpc, () => imageStatus());
  handle(rpc.avatarSetKeyRpc, setImageKey);
  handle(rpc.avatarRemoveKeyRpc, () => removeImageKey());
  handle(rpc.avatarGenerateRpc, generateAvatar);
  handle(rpc.appsStatusRpc, () => appsStatus());
  handle(rpc.appsSetKeyRpc, setKey);
  handle(rpc.appsRemoveKeyRpc, () => removeKey());
  handle(rpc.appsCatalogRpc, () => catalog());
  handle(rpc.appsAccountsRpc, accounts);
  handle(rpc.appsConnectRpc, connect);
  handle(rpc.appsDisconnectRpc, disconnect);
  handle(rpc.appsRenameRpc, renameAccount);
  handle(rpc.appsToolsRpc, appTools);

  // ------------------------------------------------------------ proposals

  handle(rpc.proposalGetRpc, async ({ id }) => ({ proposal: await getProposal(id) }));
  handle(rpc.proposalDismissRpc, async ({ id }) => ({ proposal: await dismissProposal(id) }));
  handle(rpc.proposalAcceptRpc, async ({ id }) => {
    const proposal = await getProposal(id);
    if (!proposal) throw new RequestError("This proposal is no longer available.");
    if (proposal.kind === "changes") {
      // Applied before the proposal counts as accepted: a change that no longer fits leaves it pending.
      const context = { now: new Date().toISOString(), provider: proposal.data.provider };
      await store.update((current) => applyChanges(current, proposal.data.changes, context));
      return acceptProposal(id);
    }
    const accepted = await acceptProposal(id);
    const { skill } = accepted;
    const botId = accepted.proposal.botId;
    await store.update((current) => {
      if (proposal.kind === "routine") {
        const routine = { id: newRoutineId(), ...proposal.data, enabled: true, createdAt: new Date().toISOString() };
        return { ...current, bots: current.bots.map((entry) => (entry.id === botId ? { ...entry, routines: [...entry.routines, routine] } : entry)) };
      }
      if (!skill) return current;
      return {
        ...current,
        library: updateSkill(upsertSkills(current.library ?? EMPTY_LIBRARY, [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }]), skill.id, { enabled: true }),
        bots: current.bots.map((entry) => (entry.id === botId ? setBotUses(entry, "skill", skill.id, true) : entry)),
      };
    });
    return accepted;
  });

  // ------------------------------------------------------------ routines, allowed commands and trusted folders

  handle(rpc.routineStatusRpc, () => scheduler.status());
  handle(rpc.routineRunNowRpc, ({ botId, routineId }) => scheduler.runNow(botId, routineId));
  handle(rpc.routineWebhookRpc, ({ routineId, rotate }) => scheduler.webhookUrl(routineId, rotate));
  handle(rpc.commandListRpc, async ({ botId }) => ({ rules: await commands.list(botId) }));
  // A new rule also answers the approvals already waiting that it covers.
  handle(rpc.commandAllowRpc, async ({ botId, command, cwd }) => {
    const rule = await commands.add(botId, command, cwd);
    await host.chats.reapprove();
    return { rule };
  });
  handle(rpc.commandRemoveRpc, async ({ botId, id }) => ({ ok: await commands.remove(botId, id) }));
  handle(rpc.folderListRpc, async ({ botId }) => ({ folders: await folders.list(botId) }));
  handle(rpc.folderAllowRpc, async ({ botId, folder }) => {
    const rule = await folders.add(botId, folder);
    await host.chats.reapprove();
    return { folder: rule };
  });
  handle(rpc.folderRemoveRpc, async ({ botId, id }) => ({ ok: await folders.remove(botId, id) }));

  return registry;
}
