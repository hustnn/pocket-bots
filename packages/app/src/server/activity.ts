import { lastTurn, logLine } from "../shared/activity";
import { BOT_LABEL } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import { shellCommand } from "../shared/commands";
import type { ApprovalPolicy, ChatService } from "./chat-service";
import { requestPaths, type CommandAllowlist, type FolderGrants } from "./commands";
import type { PocketHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat:
// the journal notes memory changes (and puts them back when the bot may not write
// its memory), the daily log gets a line saying what the bot did (always: it is the
// app's own record, not the bot's writing), and a routine's run is recorded.

export function wireActivity(input: { watcher: ChatService; host: PocketHost; journal: MemoryJournal; scheduler: RoutineScheduler }): void {
  const { watcher, host, journal, scheduler } = input;

  watcher.on("turn.started", async ({ agent }) => {
    const botId = agent.labels?.[BOT_LABEL];
    if (!botId) return;
    const bot = await host.bot(botId);
    await journal.begin(botId, agent.id, { readOnly: !!bot && !bot.memoryAutoWrite });
  });

  // A deleted chat's turn won't end; the journal mustn't wait for it.
  watcher.on("agent.removed", async ({ agentId }) => {
    await journal.forget(agentId);
  });

  watcher.on("turn.ended", async ({ agent, outcome, timeline, missed }) => {
    const botId = agent.labels?.[BOT_LABEL];
    if (!botId) return;
    const title = agent.title?.trim() || "Untitled chat";
    // The switch as it is now, not as it was when the turn began.
    const bot = await host.bot(botId);
    // A turn nobody saw start has nothing to compare memory with; the next turn's start catches it up.
    if (missed) await journal.leave(botId, agent.id);
    else await journal.end(botId, { id: agent.id, title }, { readOnly: !!bot && !bot.memoryAutoWrite });
    const { reply, tools } = lastTurn(timeline);
    const routineId = agent.labels?.[ROUTINE_LABEL];
    if (routineId) await scheduler.finished(routineId, agent.id, outcome, reply);
    if (outcome.kind === "canceled") return;
    const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
    if (line) await appendDailyLog(botId, line);
  });

}

/**
 * What a bot was allowed to do without asking: its saved commands (exact command, exact folder),
 * and a command or file operation that stays inside a folder the user trusts it with.
 */
export function savedApprovals(commands: CommandAllowlist, folders: FolderGrants): ApprovalPolicy {
  return async (agent, request) => {
    const botId = agent.labels?.[BOT_LABEL];
    if (!botId) return null;
    const shell = shellCommand(request, agent.cwd);
    if (shell && (await commands.matches(botId, shell.command, shell.cwd))) return { behavior: "allow" };
    const paths = requestPaths(request, agent.cwd);
    if (paths && (await folders.covers(botId, paths))) return { behavior: "allow" };
    return null;
  };
}
