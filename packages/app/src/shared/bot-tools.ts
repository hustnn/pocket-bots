// pocket-bots' own tools, served to every local bot chat as the MCP server
// "bots": other bots, past chats, the setup, and proposals (skills, routines,
// setup changes, app connections) the user confirms in the chat.

export const TOOLS_MCP_NAME = "bots";

const BOT_TOOL_NAMES = ["group_send", "group_send_draft", "group_read", "group_inbox", "group_search", "group_claim", "group_task", "group_react", "group_mute", "group_follow", "group_reminder", "group_mention_delivery", "group_members", "list_bots", "ask_bot", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Tools that only read, only propose something the user confirms, or speak in
 * a group chat the user put the bot in, so they run without a permission
 * prompt. Asking another bot is left to the bot's "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = ["group_send", "group_send_draft", "group_read", "group_inbox", "group_search", "group_claim", "group_task", "group_react", "group_mute", "group_follow", "group_reminder", "group_mention_delivery", "group_members", "list_bots", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"];

/**
 * The bot tool a timeline tool call is, whatever the provider calls it:
 * Claude `mcp__bots__ask_bot`, Codex `bots.ask_bot`, others `bots_ask_bot`.
 */
export function botToolName(name: string): BotToolName | null {
  const match = /^(?:mcp__)?bots(?:__|\.|_)([a-z_]+)$/.exec(name.trim());
  const tool = match?.[1];
  return tool && (BOT_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as BotToolName) : null;
}

/** The prompt section for pocket-bots' own tools, given to chats that get them (bots on this host). */
export function botToolsPrompt(canAsk: boolean): string {
  const others = canAsk
    ? "list_bots to see the other bots and ask_bot to ask one for help. When ask_bot says the answer will come to the chat on its own, tell the user it's on its way and end your turn rather than checking again"
    : "list_bots to see the other bots";
  return `Your own tools come from the MCP server "bots". Use propose_routine for your own recurring or webhook-started work (rather than your runtime's own schedule or cron tools) and propose_skill to keep a way of working for next time. When the user asks you to set up or change bots, skills, MCP servers or defaults, read get_setup and put all the changes in one propose_changes call. The user confirms proposals on a card in the chat. Use search_chats to look through your past chats and daily log, and ${others}.`;
}
