import type { ChatSnapshot, ProvidersSnapshot, TimelinePage } from "./chat-types";
import { z } from "zod";
import { BotMcpServerSchema, BotSchema, McpServerConfigSchema, McpToolSchema, StoreSchema } from "./bot";
import { MAX_EXTRA_FOLDERS } from "./extra-folders";
import { GROUP_MAX_BOTS, GROUP_NAME_MAX, GroupMessageSchema, GroupSummarySchema, GroupTaskSchema, TaskStatusSchema, USER_TEXT_MAX, WakeModeSchema, WorkbenchModeSchema } from "./group-chat";
import { ProposalSchema } from "./proposals";
import { defineRpc } from "./rpc-core";

export type { ChatSnapshot, TimelineEntry, TimelinePage } from "./chat-types";

const BotId = z.string().regex(/^[a-z0-9-]+$/);
/** "MEMORY.md" or a topic file such as "projects.md" (stored under memory/). */
const MemoryFileName = z.string().regex(/^[A-Za-z0-9 ._-]+\.md$/);
const SkillName = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * Creates (if needed) the Bots project folder and this bot's folder inside it.
 * `root` backs the Bots project, `path` the bot's workspace.
 */
export const ensureBotHomeRpc = defineRpc({
  name: "bots.ensure-home",
  input: z.object({ botId: BotId }),
  output: z.object({ root: z.string(), path: z.string() }),
});

const PromptSectionSchema = z.object({ title: z.string(), text: z.string() });

/** The bot's system prompt as it would be sent now, with its memory and skills; `message` (a new chat's first) picks its playbooks. */
export const systemPromptRpc = defineRpc({
  name: "bots.system-prompt",
  input: z.object({ bot: BotSchema, local: z.boolean(), message: z.string().max(100_000).optional() }),
  output: z.object({ systemPrompt: z.string(), sections: z.array(PromptSectionSchema) }),
});

const MemoryFileSchema = z.object({ name: MemoryFileName, bytes: z.number(), lines: z.number(), topic: z.boolean() });

export const memoryListRpc = defineRpc({
  name: "bots.memory.list",
  input: z.object({ botId: BotId }),
  output: z.object({ folder: z.string(), files: z.array(MemoryFileSchema), injectedLines: z.number(), injectedBytes: z.number() }),
});

export const memoryReadRpc = defineRpc({
  name: "bots.memory.read",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ text: z.string() }),
});

export const memoryWriteRpc = defineRpc({
  name: "bots.memory.write",
  input: z.object({ botId: BotId, name: MemoryFileName, text: z.string().max(200_000) }),
  output: z.object({ ok: z.boolean() }),
});

export const memoryDeleteRpc = defineRpc({
  name: "bots.memory.delete",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ ok: z.boolean() }),
});

const LogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The daily log: its days, and one day's text when `day` is given. */
export const memoryLogRpc = defineRpc({
  name: "bots.memory.log",
  input: z.object({ botId: BotId, day: LogDay.optional() }),
  output: z.object({ days: z.array(z.object({ day: z.string(), lines: z.number() })), text: z.string().nullable() }),
});

export const memoryLogDeleteRpc = defineRpc({
  name: "bots.memory.log-delete",
  input: z.object({ botId: BotId, day: LogDay }),
  output: z.object({ ok: z.boolean() }),
});

const JournalEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  file: z.string(),
  actor: z.enum(["bot", "you"]),
  via: z.enum(["chat", "app", "disk", "undo", "restore"]),
  chat: z.object({ id: z.string(), title: z.string() }).nullable(),
  kind: z.enum(["created", "edited", "deleted"]),
  diff: z.string(),
  added: z.number(),
  removed: z.number(),
  canUndo: z.boolean(),
});
export type JournalRow = z.infer<typeof JournalEntrySchema>;

/** Recent changes to a bot's memory files, newest first. */
export const memoryJournalRpc = defineRpc({
  name: "bots.memory.journal",
  input: z.object({ botId: BotId }),
  output: z.object({ entries: z.array(JournalEntrySchema) }),
});

/** Puts a memory file back the way it was before a change. */
export const memoryUndoRpc = defineRpc({
  name: "bots.memory.undo",
  input: z.object({ botId: BotId, id: z.string().regex(/^j-[a-z0-9]+$/) }),
  output: z.object({ ok: z.boolean() }),
});

const ImportedSkillSchema = z.object({ id: SkillName, description: z.string(), source: z.string() });

/** Imports skills into the library from "owner/repo", "owner/repo/path", a GitHub URL or a raw SKILL.md URL. */
export const skillImportRpc = defineRpc({
  name: "bots.library.import-skills",
  input: z.object({ source: z.string().min(1).max(500) }),
  output: z.object({ skills: z.array(ImportedSkillSchema) }),
});

export const skillReadRpc = defineRpc({
  name: "bots.library.read-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ text: z.string(), sha: z.string().nullable(), missing: z.boolean(), path: z.string(), files: z.array(z.string()) }),
});

/** Creates or replaces a library skill's SKILL.md; returns its frontmatter description and hash. */
export const skillWriteRpc = defineRpc({
  name: "bots.library.write-skill",
  input: z.object({ id: SkillName, text: z.string().max(256_000) }),
  output: z.object({ description: z.string(), sha: z.string() }),
});

export const skillDeleteRpc = defineRpc({
  name: "bots.library.delete-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ ok: z.boolean() }),
});

/** Starts or connects to an MCP server, lists its tools and disconnects. */
export const mcpProbeRpc = defineRpc({
  name: "bots.library.test-mcp",
  input: z.object({ config: McpServerConfigSchema }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), tools: z.array(McpToolSchema) }), z.object({ ok: z.literal(false), error: z.string() })]),
});

/** MCP servers other apps on this computer have (Claude Code, Claude Desktop, Cursor), to import. */
export const mcpSourcesRpc = defineRpc({
  name: "bots.library.mcp-sources",
  input: z.object({}),
  output: z.object({ sources: z.array(z.object({ label: z.string(), count: z.number(), json: z.string() })) }),
});

// ---------------------------------------------------------------- avatar pictures

/** Whether an OpenAI key for drawing avatars is saved on this host; only its last characters are shown. */
export const avatarKeyStatusRpc = defineRpc({
  name: "bots.avatar.status",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), keyHint: z.string().nullable() }),
});

export const avatarSetKeyRpc = defineRpc({
  name: "bots.avatar.set-key",
  input: z.object({ key: z.string().min(1).max(400) }),
  output: z.object({ ok: z.boolean() }),
});

export const avatarRemoveKeyRpc = defineRpc({
  name: "bots.avatar.remove-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

/** Draws an avatar from a bot's name, role and an optional direction; returns a WebP data URL. */
export const avatarGenerateRpc = defineRpc({
  name: "bots.avatar.generate",
  input: z.object({ name: z.string().max(200), title: z.string().max(400), description: z.string().max(4000), direction: z.string().max(400) }),
  output: z.object({ image: z.string() }),
});

/** One run of a routine. */
const RoutineRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual", "webhook"]),
  /** When the run was due; for manual and webhook runs, when it was asked for. */
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped-busy", "skipped-missed"]),
  agentId: z.string().nullable(),
  /** The start of the bot's reply once the run finished. */
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

/** A run's card in the routine's results chat, kept by pocket-bots and replaced (same id) when the run finishes. */
export const RoutineRunCardSchema = RoutineRunSchema.pick({ trigger: true, scheduledFor: true, status: true, agentId: true, output: true, error: true }).extend({ routineName: z.string() });
export type RoutineRunCard = z.infer<typeof RoutineRunCardSchema>;
export const ROUTINE_RUN_CARD = { kind: "routine-run", version: 1 } as const;

const RoutineRecordSchema = z.object({
  /** The last time the schedule fired (runs, skips and misses), which the next due time counts from. */
  lastRunAt: z.string().nullable(),
  /** The latest runs, oldest first. */
  runs: z.array(RoutineRunSchema),
});
export type RoutineRecord = z.infer<typeof RoutineRecordSchema>;

export const routineStatusRpc = defineRpc({
  name: "bots.routines.status",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean(), routines: z.record(z.string(), RoutineRecordSchema) }),
});

export const routineRunNowRpc = defineRpc({
  name: "bots.routines.run-now",
  input: z.object({ botId: BotId, routineId: z.string() }),
  output: z.object({ run: RoutineRunSchema }),
});

/** The routine's webhook URL on this host; `rotate` replaces its secret so the old URL stops working. */
export const routineWebhookRpc = defineRpc({
  name: "bots.routines.webhook",
  input: z.object({ routineId: z.string().regex(/^[a-z0-9-]+$/), rotate: z.boolean().optional() }),
  output: z.object({ url: z.string() }),
});

/** A shareable bot file: identity, soul, its skills and MCP servers, routines (paused) and optionally memory. Secrets are redacted. */
export const exportBotRpc = defineRpc({
  name: "bots.export",
  input: z.object({ bot: BotSchema, includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Writes an exported bot's files for `botId`; returns the bot fields to save and what to add to the library. */
export const importBotRpc = defineRpc({
  name: "bots.import",
  input: z.object({ botId: BotId, json: z.string().max(5_000_000) }),
  output: z.object({ bot: BotSchema, skills: z.array(ImportedSkillSchema), mcpServers: z.array(BotMcpServerSchema) }),
});

const ImportedBotSchema = z.object({ bot: BotSchema, skills: z.array(ImportedSkillSchema), mcpServers: z.array(BotMcpServerSchema) });

/** Several bots in one file; secrets are redacted as in single exports. */
export const exportBotsRpc = defineRpc({
  name: "bots.export-many",
  input: z.object({ bots: z.array(BotSchema).min(1).max(50), includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Imports a file of several bots, or a single bot file, as new bots. Teams in older files are left out. */
export const importBotsRpc = defineRpc({
  name: "bots.import-many",
  input: z.object({ json: z.string().max(20_000_000) }),
  output: z.object({ bots: z.array(ImportedBotSchema) }),
});

/** Stores a picked file on this host so it can be sent as an `uploaded_file` attachment. */
export const uploadRpc = defineRpc({
  name: "bots.upload",
  input: z.object({ botId: BotId, fileName: z.string().min(1).max(255), dataBase64: z.string().max(36_000_000) }),
  output: z.object({ path: z.string(), size: z.number() }),
});

// ---------------------------------------------------------------- connected apps

const AppCardSchema = z.object({ slug: z.string(), name: z.string(), description: z.string(), logo: z.string().nullable(), domain: z.string().nullable(), noAuth: z.boolean() });
const AppAccountSchema = z.object({ id: z.string(), slug: z.string(), status: z.enum(["connected", "pending", "failed"]), alias: z.string().nullable(), name: z.string().nullable(), wordId: z.string().nullable() });

/** A sign-in a bot started, as its chat shows it. */
export const APP_SIGN_IN_CARD = { kind: "app-sign-in", version: 1 } as const;
export const AppSignInSchema = z.object({ slug: z.string(), url: z.string(), wordId: z.string().nullable(), alias: z.string().nullable() });
const Alias = z.string().max(40).regex(/^[\w .@+-]*$/, "Use letters, numbers, spaces, dots and dashes");
const AppSlug = z.string().regex(/^[a-z0-9_-]+$/);

/** Whether a Composio project key is saved on this host; only its last characters are shown. */
export const appsStatusRpc = defineRpc({
  name: "bots.apps.status",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), keyHint: z.string().nullable() }),
});

/** Saves a Composio project key after opening a session with it. */
export const appsSetKeyRpc = defineRpc({
  name: "bots.apps.set-key",
  input: z.object({ key: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

export const appsRemoveKeyRpc = defineRpc({
  name: "bots.apps.remove-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const appsCatalogRpc = defineRpc({
  name: "bots.apps.catalog",
  input: z.object({}),
  output: z.object({ apps: z.array(AppCardSchema) }),
});

export const appsAccountsRpc = defineRpc({
  name: "bots.apps.accounts",
  input: z.object({ fresh: z.boolean().optional() }),
  output: z.object({ accounts: z.array(AppAccountSchema) }),
});

/** A Composio-hosted sign-in link for an app; `alias` names the new account. */
export const appsConnectRpc = defineRpc({
  name: "bots.apps.connect",
  input: z.object({ slug: AppSlug, alias: Alias.optional() }),
  output: z.object({ url: z.string() }),
});

/** Names an account (unique per app); "" clears the name. */
export const appsRenameRpc = defineRpc({
  name: "bots.apps.rename",
  input: z.object({ accountId: z.string().min(1).max(200), alias: Alias }),
  output: z.object({ ok: z.boolean() }),
});

/** An app's tools, and which ones Composio marks read-only, for choosing what a bot may run. */
export const appsToolsRpc = defineRpc({
  name: "bots.apps.tools",
  input: z.object({ slug: AppSlug }),
  output: z.object({ tools: z.array(z.object({ slug: z.string(), name: z.string(), readOnly: z.boolean() })) }),
});

export const appsDisconnectRpc = defineRpc({
  name: "bots.apps.disconnect",
  input: z.object({ accountId: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

// ---------------------------------------------------------------- proposals

const ProposalId = z.string().regex(/^p-[a-z0-9]+$/);

/** A proposal a bot made in a chat; null once it's gone. */
export const proposalGetRpc = defineRpc({
  name: "bots.proposals.get",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema.nullable() }),
});

/** Accepts a proposal: writes a skill to the library, adds a routine to its bot, or applies setup changes. */
export const proposalAcceptRpc = defineRpc({
  name: "bots.proposals.accept",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema, skill: z.object({ id: SkillName, description: z.string(), sha: z.string() }).optional() }),
});

export const proposalDismissRpc = defineRpc({
  name: "bots.proposals.dismiss",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema }),
});

// ---------------------------------------------------------------- allowed commands

const CommandRuleSchema = z.object({ id: z.string(), command: z.string(), cwd: z.string() });

/** Commands a bot runs without asking: exact command, exact folder. */
export const commandListRpc = defineRpc({
  name: "bots.commands.list",
  input: z.object({ botId: BotId }),
  output: z.object({ rules: z.array(CommandRuleSchema) }),
});

export const commandAllowRpc = defineRpc({
  name: "bots.commands.allow",
  input: z.object({ botId: BotId, command: z.string().min(1).max(16_384), cwd: z.string().min(1).max(4_096) }),
  output: z.object({ rule: CommandRuleSchema }),
});

export const commandRemoveRpc = defineRpc({
  name: "bots.commands.remove",
  input: z.object({ botId: BotId, id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

const FolderRuleSchema = z.object({ id: z.string(), folder: z.string() });

/** Folders a bot works in without asking: commands run there, and reading, editing, writing and searching files in them. */
export const folderListRpc = defineRpc({
  name: "bots.folders.list",
  input: z.object({ botId: BotId }),
  output: z.object({ folders: z.array(FolderRuleSchema) }),
});

export const folderAllowRpc = defineRpc({
  name: "bots.folders.allow",
  input: z.object({ botId: BotId, folder: z.string().min(1).max(4_096) }),
  output: z.object({ folder: FolderRuleSchema }),
});

export const folderRemoveRpc = defineRpc({
  name: "bots.folders.remove",
  input: z.object({ botId: BotId, id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// ================================================================ pocket-bots
// The bots document, chats and the runtimes' providers, served by pocket-bots's server.

const AgentSnapshot = z.custom<ChatSnapshot>((value) => typeof value === "object" && value !== null);
const ChatId = z.uuid();

/** The bots document and its revision; saves name the revision they started from. */
export const storeGetRpc = defineRpc({
  name: "pocket.store.get",
  input: z.object({}),
  output: z.object({ values: StoreSchema, revision: z.string() }),
});

export const storeSaveRpc = defineRpc({
  name: "pocket.store.save",
  input: z.object({ values: z.unknown(), revision: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), revision: z.string(), values: StoreSchema }),
    z.object({ status: z.literal("conflict"), revision: z.string() }),
    z.object({ status: z.literal("invalid"), error: z.string() }),
  ]),
});

/** Sets the bots document aside (when it can't be read) and starts an empty one. */
export const storeResetRpc = defineRpc({
  name: "pocket.store.reset",
  input: z.object({}),
  /** `backup` is where the old file went; null when there was none. */
  output: z.object({ backup: z.string().nullable(), revision: z.string() }),
});

export const statusRpc = defineRpc({
  name: "pocket.status",
  input: z.object({}),
  output: z.object({ version: z.string(), dataPath: z.string(), scheduler: z.boolean() }),
});

export const providersRpc = defineRpc({
  name: "pocket.providers",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.custom<ProvidersSnapshot>((value) => typeof value === "object" && value !== null),
});

export const chatsListRpc = defineRpc({
  name: "pocket.chats.list",
  input: z.object({ botId: BotId, includeArchived: z.boolean().optional() }),
  output: z.object({ chats: z.array(AgentSnapshot) }),
});

/** Every active bot chat, for the bot list's status. */
export const chatsAllRpc = defineRpc({
  name: "pocket.chats.all",
  input: z.object({}),
  output: z.object({ chats: z.array(AgentSnapshot) }),
});

export const chatGetRpc = defineRpc({
  name: "pocket.chats.get",
  input: z.object({ chatId: ChatId }),
  output: z.object({ agent: AgentSnapshot.nullable() }),
});

const Cursor = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });

export const chatTimelineRpc = defineRpc({
  name: "pocket.chats.timeline",
  input: z.object({ chatId: ChatId, direction: z.enum(["tail", "before", "after"]), cursor: Cursor.optional(), limit: z.number().int().min(1).max(500).optional() }),
  output: z.custom<TimelinePage>((value) => typeof value === "object" && value !== null),
});

const ImageInput = z.object({ data: z.string().max(15_000_000), mimeType: z.string() });
const AttachmentInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), mimeType: z.literal("text/plain"), title: z.string(), text: z.string().max(1_100_000) }),
  z.object({ type: z.literal("uploaded_file"), id: z.string(), fileName: z.string(), mimeType: z.string(), size: z.number(), path: z.string() }),
]);
const MessageInput = {
  text: z.string().max(200_000),
  images: z.array(ImageInput).max(20).optional(),
  attachments: z.array(AttachmentInput).max(20).optional(),
  /** The id of the user message, so the UI can match its optimistic copy. */
  messageId: z.string().max(100).optional(),
};

/** The bot's words a message replies to (Reply): quoted in front of it (see reply.ts). */
const ReplyQuote = z.string().max(20_000).optional();

/** A folder on this computer a chat or a group works in: absolute, or under ~/. */
const WorkFolder = z.string().max(4096);

/** Folders besides the working folder a chat or a group may use (at most MAX_EXTRA_FOLDERS; the server checks each). */
const ExtraFolders = z.array(WorkFolder).max(MAX_EXTRA_FOLDERS);

/** Starts a new chat with a bot; with `cwd`, in that folder instead of the bot's own; with `extraFolders`, using those folders too. */
export const chatStartRpc = defineRpc({
  name: "pocket.chats.start",
  input: z.object({ botId: BotId, ...MessageInput, cwd: WorkFolder.nullable().optional(), extraFolders: ExtraFolders.optional() }),
  output: z.object({ chatId: z.string() }),
});

/**
 * Replaces a chat's extra folders. Its working folder stays; the chat's session carries on with
 * the new list (in place on Codex, resumed once it's idle on the others). Not for a group seat,
 * whose folders are its group's.
 */
export const chatFoldersRpc = defineRpc({
  name: "pocket.chats.folders",
  input: z.object({ chatId: ChatId, extraFolders: ExtraFolders }),
  output: z.object({ extraFolders: z.array(z.string()) }),
});

/** Sends a message to a chat; while it's working the message steers (default) or interrupts the current turn. */
export const chatSendRpc = defineRpc({
  name: "pocket.chats.send",
  input: z.object({ chatId: ChatId, ...MessageInput, quote: ReplyQuote, activeTurnBehavior: z.enum(["steer", "interrupt"]).optional() }),
  output: z.object({ ok: z.boolean() }),
});

/** Stops the chat's running turn. */
export const chatStopRpc = defineRpc({
  name: "pocket.chats.stop",
  input: z.object({ chatId: ChatId }),
  output: z.object({ ok: z.boolean() }),
});

const PermissionResponseSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("allow"), selectedActionId: z.string().optional(), updatedInput: z.record(z.string(), z.unknown()).optional() }),
  z.object({ behavior: z.literal("deny"), selectedActionId: z.string().optional(), message: z.string().optional(), interrupt: z.boolean().optional() }),
]);

export const chatRespondRpc = defineRpc({
  name: "pocket.chats.respond",
  input: z.object({ chatId: ChatId, requestId: z.string(), response: PermissionResponseSchema }),
  output: z.object({ ok: z.boolean() }),
});

export const chatArchiveRpc = defineRpc({
  name: "pocket.chats.archive",
  input: z.object({ chatId: ChatId }),
  output: z.object({ ok: z.boolean() }),
});

/** A chat as Markdown, for export. */
export const chatTranscriptRpc = defineRpc({
  name: "pocket.chats.transcript",
  input: z.object({ chatId: ChatId }),
  output: z.object({ title: z.string(), markdown: z.string() }),
});

/** A card pocket-bots shows in a chat between its messages (a routine run's result). */
export const ChatCardSchema = z.object({ id: z.string(), at: z.string(), kind: z.literal("routine-run"), data: RoutineRunCardSchema });
export type ChatCard = z.infer<typeof ChatCardSchema>;

export const chatCardsRpc = defineRpc({
  name: "pocket.chats.cards",
  input: z.object({ chatId: ChatId }),
  output: z.object({ cards: z.array(ChatCardSchema) }),
});

/** Folders bots, groups and chats already work in, to pick a working folder from. */
export const workspacesRpc = defineRpc({
  name: "pocket.workspaces",
  input: z.object({}),
  output: z.object({ workspaces: z.array(z.object({ id: z.string(), directory: z.string() })) }),
});

/** A slash command the chat's provider offers (Claude Code's /compact, a custom command, a skill). */
export const SlashCommandSchema = z.object({ name: z.string(), description: z.string(), argumentHint: z.string(), kind: z.enum(["command", "skill"]).optional() });
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

export const chatCommandsRpc = defineRpc({
  name: "pocket.chats.commands",
  input: z.object({ chatId: ChatId }),
  output: z.object({ commands: z.array(SlashCommandSchema), error: z.string().nullable() }),
});


// Messages queued while a bot works. pocket-bots keeps them and sends them one
// at a time whenever the chat is idle, so they go out with the browser closed too.

const ComposerAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), id: z.string(), name: z.string(), mimeType: z.string(), size: z.number(), data: z.string().max(15_000_000) }),
  z.object({ kind: z.literal("text"), id: z.string(), name: z.string(), size: z.number(), text: z.string().max(1_100_000) }),
  z.object({ kind: z.literal("file"), id: z.string(), name: z.string(), mimeType: z.string(), size: z.number(), path: z.string() }),
]);

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string().max(200_000),
  attachments: z.array(ComposerAttachmentSchema).max(20),
  quote: ReplyQuote,
  queuedAt: z.string(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/** A queued message as the composer lists it (no image data). */
const QueuedSummarySchema = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(z.object({ kind: z.enum(["image", "text", "file"]), name: z.string() })),
  quote: z.string().optional(),
  queuedAt: z.string(),
});
export type QueuedSummary = z.infer<typeof QueuedSummarySchema>;

export const queueListRpc = defineRpc({
  name: "pocket.queue.list",
  input: z.object({ chatId: ChatId }),
  /** `error` is why the last queued send failed; the queue waits until it's resumed. */
  output: z.object({ messages: z.array(QueuedSummarySchema), error: z.string().nullable() }),
});

/** Queues a message; it goes out right away when the chat is already idle. */
export const queueAddRpc = defineRpc({
  name: "pocket.queue.add",
  input: z.object({ chatId: ChatId, text: z.string().max(200_000), attachments: z.array(ComposerAttachmentSchema).max(20), quote: ReplyQuote }),
  output: z.object({ id: z.string() }),
});

/** Takes a message back out of the queue, to edit or drop it. */
export const queueTakeRpc = defineRpc({
  name: "pocket.queue.take",
  input: z.object({ chatId: ChatId, id: z.string() }),
  output: z.object({ message: QueuedMessageSchema.nullable() }),
});

/** Sends one queued message now, steering or interrupting the current turn. */
export const queueSendNowRpc = defineRpc({
  name: "pocket.queue.send-now",
  input: z.object({ chatId: ChatId, id: z.string(), activeTurnBehavior: z.enum(["steer", "interrupt"]) }),
  output: z.object({ ok: z.boolean() }),
});

/** Clears a failed send and lets the queue drain again. */
export const queueResumeRpc = defineRpc({
  name: "pocket.queue.resume",
  input: z.object({ chatId: ChatId }),
  output: z.object({ ok: z.boolean() }),
});

// ---------------------------------------------------------------- group chats

const GroupId = z.string().regex(/^group-[a-z0-9]+$/);
const MemberIds = z.array(BotId).max(GROUP_MAX_BOTS * 2);

export const groupsListRpc = defineRpc({
  name: "pocket.groups.list",
  input: z.object({}),
  output: z.object({ groups: z.array(GroupSummarySchema) }),
});

/** A new group with two to six bots; with no name it's named after them. */
export const groupCreateRpc = defineRpc({
  name: "pocket.groups.create",
  /**
   * `leaderId`: one of the bots, which plans and hands out the work; the others take only what it hands them.
   * `cwd`: the folder every bot's session for the group works in; without one, each works in its own.
   * `extraFolders`: folders every bot may use besides it.
   */
  input: z.object({ name: z.string().max(GROUP_NAME_MAX).nullable().optional(), memberIds: MemberIds, leaderId: z.string().min(1).nullable().optional(), cwd: WorkFolder.nullable().optional(), extraFolders: ExtraFolders.optional() }),
  output: z.object({ groupId: z.string() }),
});

/** Renames a group, changes its members or its leader, or how its messages wake the bots. */
export const groupUpdateRpc = defineRpc({
  name: "pocket.groups.update",
  input: z.object({
    groupId: GroupId,
    name: z.string().max(GROUP_NAME_MAX).nullable().optional(),
    memberIds: MemberIds.nullable().optional(),
    wakeMode: WakeModeSchema.nullable().optional(),
    /** off, or full obligation wakes; a leader group can't turn it on. */
    workbenchMode: WorkbenchModeSchema.nullable().optional(),
    /** A member to lead the group, or null for no leader; left out, the leader stays. */
    leaderId: z.string().min(1).nullable().optional(),
    /** The group's working folder, or null for each bot's own; left out, it stays. */
    cwd: WorkFolder.nullable().optional(),
    /** The group's extra folders, replacing the list; left out, it stays. */
    extraFolders: ExtraFolders.optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * The user's task actions: claim or convert a message, unclaim, set any status, assign to
 * a bot (its id), "user" or nobody (null), or remove the task (the message stays).
 */
export const groupTaskRpc = defineRpc({
  name: "pocket.groups.task",
  input: z.object({
    groupId: GroupId,
    action: z.enum(["claim", "convert", "unclaim", "status", "assign", "delete", "amend"]),
    seq: z.number().int().positive().nullable().optional(),
    number: z.number().int().positive().nullable().optional(),
    status: TaskStatusSchema.nullable().optional(),
    assignee: z.string().max(100).nullable().optional(),
    /** amend: the card's new title; and its new description, or null to clear it. */
    title: z.string().max(10_000).nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/** The group's tasks, for the task board. */
export const groupTasksRpc = defineRpc({
  name: "pocket.groups.tasks",
  input: z.object({ groupId: GroupId }),
  output: z.object({ tasks: z.array(GroupTaskSchema.extend({ preview: z.string(), replies: z.number() })) }),
});

/** The bots' pending reminders in a group, soonest first. */
export const groupRemindersRpc = defineRpc({
  name: "pocket.groups.reminders",
  input: z.object({ groupId: GroupId }),
  output: z.object({
    reminders: z.array(
      z.object({
        id: z.string(),
        owner: z.string(),
        title: z.string(),
        anchor: z.number(),
        anchorThread: z.number().nullable(),
        fireAt: z.string(),
        firedAt: z.string().nullable(),
        status: z.enum(["scheduled", "fired", "canceled"]),
        repeat: z.string().nullable(),
      }),
    ),
  }),
});

/** The user's reaction to a message; the same emoji again takes it back. */
/** The user's answer to a bot's question in the group: it goes to the seat that asked. */
export const groupAnswerRpc = defineRpc({
  name: "pocket.groups.answer",
  input: z.object({ groupId: GroupId, seq: z.number().int().positive(), response: PermissionResponseSchema }),
  output: z.object({ ok: z.boolean() }),
});

export const groupReactRpc = defineRpc({
  name: "pocket.groups.react",
  input: z.object({ groupId: GroupId, seq: z.number().int().positive(), emoji: z.string().min(1).max(16) }),
  output: z.object({ ok: z.boolean() }),
});

/** A message the search found: where it is (a bot's chat or a group, and its place there) and a piece of it around the match. */
export const SearchHitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), botId: z.string(), chatId: z.string(), chatTitle: z.string(), archived: z.boolean(), seq: z.number(), from: z.enum(["user", "bot"]), text: z.string(), at: z.string() }),
  z.object({
    kind: z.literal("group"),
    groupId: z.string(),
    seq: z.number(),
    thread: z.number().nullable(),
    from: z.discriminatedUnion("kind", [z.object({ kind: z.literal("user") }), z.object({ kind: z.literal("bot"), botId: z.string(), name: z.string() })]),
    text: z.string(),
    at: z.string(),
  }),
]);
export type SearchHit = z.infer<typeof SearchHitSchema>;

/** Search: messages in one-to-one chats and groups with every word, newest first; or in one chat (find in chat) or one group. */
export const searchRpc = defineRpc({
  name: "pocket.search",
  input: z.object({ query: z.string().min(1).max(200), chatId: z.string().optional(), groupId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ hits: z.array(SearchHitSchema) }),
});

/** Messages that match words, best first. */
export const groupSearchRpc = defineRpc({
  name: "pocket.groups.search",
  input: z.object({ groupId: GroupId, query: z.string().min(1).max(200) }),
  output: z.object({ messages: z.array(GroupMessageSchema) }),
});

/** Mutes a bot in a group: only messages that address it wake it. */
export const groupMuteRpc = defineRpc({
  name: "pocket.groups.mute",
  input: z.object({ groupId: GroupId, botId: z.string().min(1), muted: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const groupDeleteRpc = defineRpc({
  name: "pocket.groups.delete",
  input: z.object({ groupId: GroupId }),
  output: z.object({ ok: z.boolean() }),
});

/** The latest messages, or the ones before `before`. */
export const groupMessagesRpc = defineRpc({
  name: "pocket.groups.messages",
  /** The top level; with `thread`, that thread's top message and its replies. */
  input: z.object({ groupId: GroupId, before: z.number().int().positive().nullable().optional(), limit: z.number().int().min(1).max(500).optional(), thread: z.number().int().positive().nullable().optional() }),
  output: z.object({ messages: z.array(GroupMessageSchema), hasOlder: z.boolean() }),
});

/** The user's message; it wakes the bots it's for. */
export const groupSendRpc = defineRpc({
  name: "pocket.groups.send",
  input: z.object({
    groupId: GroupId,
    text: z.string().max(USER_TEXT_MAX),
    replyTo: z.number().int().positive().nullable().optional(),
    /** Post in this top-level message's thread. */
    thread: z.number().int().positive().nullable().optional(),
    attachments: z.array(ComposerAttachmentSchema).max(20).default([]),
    /** Send it as a task (todo, unassigned): "As task". */
    asTask: z.boolean().optional(),
  }),
  output: z.object({ seq: z.number() }),
});

/** The user has read the group's top level (or, with `thread`, that thread) up to `seq`. */
export const groupReadRpc = defineRpc({
  name: "pocket.groups.read",
  input: z.object({ groupId: GroupId, seq: z.number().int().min(0), thread: z.number().int().positive().nullable().optional() }),
  output: z.object({ ok: z.boolean() }),
});

/** Stores a picked file with the group so the bots can open it. */
export const groupUploadRpc = defineRpc({
  name: "pocket.groups.upload",
  input: z.object({ groupId: GroupId, fileName: z.string().min(1).max(255), dataBase64: z.string().max(36_000_000) }),
  output: z.object({ path: z.string(), size: z.number() }),
});

/** Server-sent events on GET /api/events. */
export type PocketEvent =
  | { type: "store"; revision: string }
  | { type: "agent"; agent: ChatSnapshot }
  | { type: "agent-removed"; agentId: string }
  /** A chat's timeline changed; `reset` means its epoch was replaced and the UI should reload it. */
  | { type: "timeline"; agentId: string; reset?: boolean }
  | { type: "cards"; agentId: string }
  | { type: "queue"; agentId: string }
  | { type: "routines" }
  /** A group chat changed: its messages, members or name, or it was created or deleted. */
  | { type: "group"; groupId: string };
