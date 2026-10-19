import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter, CodexAdapter, FakeAdapter, GrokAdapter, OpenCodeAdapter, PiAdapter, type ProviderId, type RuntimeAdapter } from "@pocket-bots/runtime";
import { GROUP_LABEL } from "../shared/group-chat";
import { savedCommands, wireActivity } from "./activity";
import { AskedAnswers } from "./answers";
import { dataPath, ensureBotsHome } from "./bot-home";
import { ChatCards } from "./cards";
import { ChatService } from "./chat-service";
import { chatSpecs, startChat } from "./chats";
import { CommandAllowlist } from "./commands";
import { loadConfig } from "./config";
import { Db } from "./db";
import { EventHub } from "./events";
import { GroupChats } from "./groups";
import { GroupStore } from "./group-store";
import { PocketHost } from "./host";
import { lockDataFolder, StartupError } from "./instance";
import { createApp, startHttp } from "./http";
import { MemoryJournal } from "./journal";
import { Relay } from "./relay";
import { rpcHandlers } from "./rpc-handlers";
import { MessageQueue } from "./queue";
import { RoutineScheduler } from "./scheduler";
import { Store } from "./store";
import { BOT_TOOLS } from "./tools";
import { ASKED_BY_LABEL } from "./tools/bots";

/** The runtimes bots can run on. POCKET_BOTS_FAKE_RUNTIME=1 adds a scripted one for tests. */
function runtimes(): Map<ProviderId, RuntimeAdapter> {
  const list: RuntimeAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter(), new PiAdapter(), new GrokAdapter()];
  if (process.env.POCKET_BOTS_FAKE_RUNTIME === "1") list.push(new FakeAdapter());
  return new Map(list.map((adapter) => [adapter.id, adapter]));
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything reads or writes the data folder: a second instance stops here.
  const lock = await lockDataFolder();
  await ensureBotsHome();

  const store = new Store();
  // An unreadable bots file shouldn't keep pocket-bots down: the web UI shows the error and can reset it.
  await store.read().catch((error: unknown) => console.error(`pocket-bots: can't read the bots file (${error instanceof Error ? error.message : String(error)}). Open the web UI to reset it.`));
  const db = new Db(join(dataPath(), "pocket-bots.sqlite"));
  const host = new PocketHost(store, runtimes());
  const hub = new EventHub();
  const commands = new CommandAllowlist();

  const queue = new MessageQueue(host, (agentId) => hub.publish({ type: "queue", agentId }));
  const answers = new AskedAnswers(host, queue);
  // Bots' tools and connected apps go through this relay; it reads the saved bots on every call.
  const relay = new Relay(host, BOT_TOOLS, { port: config.relayPort, answers });
  const relayPort = await relay.start();
  const groups = new GroupChats(host, new GroupStore(db), (bot, input) => startChat(host, bot, input), (groupId) => hub.publish({ type: "group", groupId }));
  relay.groups = groups;

  const chats = new ChatService(db, host.runtimes, chatSpecs(host, relay, async (groupId) => groups.groupName(groupId)), savedCommands(commands));
  host.chats = chats;
  // What a seat's model has seen moves once its runtime takes the message in, and starts over with a new model context.
  chats.on("input.accepted", (event) => groups.onInputAccepted(event));
  chats.on("session.opened", (event) => groups.onSessionOpened(event));
  chats.on("compaction", ({ chatId }) => groups.onCompaction(chatId));
  // A seat whose runtime didn't start goes the way of a spawn failure; one that started ends its backoff.
  chats.on("start.failed", (event) => groups.onStartFailed(event));
  chats.on("start.ready", (event) => groups.onStartReady(event));
  chats.on("session.reset", (event) => groups.onSessionReset(event));
  // A seat's question for the user shows in its group as the bot's, and follows its approval to the end.
  chats.on("permission.requested", (event) => groups.onPermission(event));
  chats.on("permission.resolved", (event) => groups.onPermissionResolved(event));

  const cards = new ChatCards();
  const scheduler = new RoutineScheduler(host, relay, cards, () => hub.publish({ type: "routines" }));
  const journal = new MemoryJournal();
  wireActivity({ watcher: chats, journal, scheduler });
  // An answer that outlasted ask_bot's wait goes to the chat that asked, once the asked chat's turn ends.
  chats.on("turn.ended", async ({ agent }) => {
    if (agent.labels?.[ASKED_BY_LABEL]) await answers.ended(agent.id);
  });
  // A seat's failed turn is noted in its group.
  chats.on("turn.ended", async ({ agent, outcome, supervision }) => {
    if (!agent.labels?.[GROUP_LABEL]) return;
    await groups.onTurnEnded(agent, { outcome: outcome.kind, error: outcome.kind === "failed" ? outcome.error.message : null, ...(supervision ? { supervision } : {}) });
  });
  chats.on("agent.updated", (agent) => hub.publish({ type: "agent", agent }));
  // Queued messages go out once a finished turn is recorded, so its log line and routine result stay its own.
  chats.on("agent.settled", (agent) => queue.onAgent(agent));
  chats.on("agent.settled", (agent) => groups.onAgent(agent));
  chats.on("agent.removed", ({ agentId }) => {
    hub.publish({ type: "agent-removed", agentId });
    void queue.forget(agentId);
    void answers.forget(agentId);
    groups.onRemoved(agentId);
  });
  store.subscribe((state) => hub.publish({ type: "store", revision: state.revision }));
  cards.onChange((agentId) => hub.publish({ type: "cards", agentId }));
  chats.start();
  scheduler.start();
  groups.resume();

  const registry = rpcHandlers({ store, host, relay, scheduler, journal, commands, cards, queue, groups });
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");
  const app = createApp({ registry, hub, host, webRoot, hostnames: config.hostnames });
  const server = await startHttp(app, config.webHost, config.webPort);
  console.log(`pocket-bots: data in ${dataPath()}, bot tools on 127.0.0.1:${relayPort}`);
  console.log(`pocket-bots: open http://${config.webHost}:${config.webPort}`);

  const shutdown = async () => {
    scheduler.stop();
    groups.close();
    relay.stop();
    server.close();
    await chats.stop();
    db.close();
    lock.release();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error("pocket-bots failed to start:", error instanceof StartupError ? error.message : error);
  process.exit(1);
});
