import { askBot, checkChat, listBots } from "./bots";
import { searchChats } from "./chats";
import { groupClaim, groupFollow, groupInbox, groupMembers, groupMentionDelivery, groupMute, groupRead, groupReact, groupReminder, groupSearch, groupSend, groupSendDraft, groupTask } from "./groups";
import type { BotTool } from "./mcp";
import { proposeRoutine } from "./routines";
import { getSetup, proposeChanges } from "./setup";
import { proposeSkill } from "./skills";

/** Every tool the "bots" MCP server offers, in the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [groupSend, groupSendDraft, groupRead, groupInbox, groupSearch, groupClaim, groupTask, groupReact, groupMute, groupFollow, groupReminder, groupMentionDelivery, groupMembers, listBots, askBot, checkChat, searchChats, getSetup, proposeSkill, proposeRoutine, proposeChanges];
