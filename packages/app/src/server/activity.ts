import { lastTurn, logLine } from "../shared/activity";
import { BOT_LABEL } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import { shellCommand } from "../shared/commands";
import type { ApprovalPolicy, ChatService } from "./chat-service";
import type { CommandAllowlist } from "./commands";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat:
// the journal notes memory changes, the daily log gets a line saying what the
// bot did, and a routine's run is recorded.

export function wireActivity(input: { watcher: ChatService; journal: MemoryJournal; scheduler: RoutineScheduler }): void {
  const { watcher, journal, scheduler } = input;

  watcher.on("turn.started", async ({ agent }) => {
    const botId = agent.labels?.[BOT_LABEL];
    if (botId) await journal.begin(botId);
  });

  watcher.on("turn.ended", async ({ agent, outcome, timeline, missed }) => {
    const botId = agent.labels?.[BOT_LABEL];
    if (!botId) return;
    const title = agent.title?.trim() || "Untitled chat";
    // A turn nobody saw start has nothing to compare memory with; the next turn's start catches it up.
    if (!missed) await journal.end(botId, { id: agent.id, title });
    const { reply, tools } = lastTurn(timeline);
    const routineId = agent.labels?.[ROUTINE_LABEL];
    if (routineId) await scheduler.finished(routineId, agent.id, outcome, reply);
    if (outcome.kind === "canceled") return;
    const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
    if (line) await appendDailyLog(botId, line);
  });

}

/** A bot's saved commands (exact command, exact folder) are approved without asking. */
export function savedCommands(commands: CommandAllowlist): ApprovalPolicy {
  return async (agent, request) => {
    const botId = agent.labels?.[BOT_LABEL];
    const shell = shellCommand(request, agent.cwd);
    if (!botId || !shell || !(await commands.matches(botId, shell.command, shell.cwd))) return null;
    return { behavior: "allow" };
  };
}
