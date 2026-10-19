import { useQuery } from "@tanstack/react-query";
import { botLimits, type Bot } from "../../../shared/bot";
import { appsStatusRpc, chatStartRpc } from "../../../shared/rpc";
import { newUuid } from "../../../shared/uuid";
import { formatCost } from "../../chat/composer";
import { Avatar } from "../../components/Avatar";
import { Button, useAction } from "../../components/ui";
import { rpc } from "../../lib/api";
import { useBotChats, useGroups, useStoreDoc } from "../../lib/data";
import { navigate } from "../../lib/router";
import { useBotActions } from "../botActions";
import type { PanelTab } from "./BotPanel";
import { Section } from "./common";

/** The first message of a chat where the bot sets itself up with you. */
const SETUP_PROMPT =
  "Let's set you up. Interview me one short question at a time about what I want from you, how I like to work, and what you should never do. " +
  "Then propose standing instructions for yourself with propose_changes, so I can apply them on the card, and a starting MEMORY.md. Write the memory file once I confirm it.";

/** Tokens and cost across the bot's open chats, from each chat's latest report. */
function Usage({ bot }: { bot: Bot }) {
  const chats = useBotChats(bot.id);
  const list = chats.data ?? [];
  const sum = (pick: (usage: NonNullable<(typeof list)[number]["lastUsage"]>) => number | undefined) => list.reduce((total, chat) => total + (chat.lastUsage ? (pick(chat.lastUsage) ?? 0) : 0), 0);
  const input = sum((usage) => usage.inputTokens);
  const output = sum((usage) => usage.outputTokens);
  const cost = formatCost(sum((usage) => usage.totalCostUsd));
  const working = list.filter((chat) => chat.status === "running" || chat.status === "initializing").length;
  const loading = chats.isPending && chats.fetchStatus !== "idle";
  return (
    <Section title="Usage" info="From each open chat's latest turn, as its provider reports it. Archived chats aren't counted.">
      <dl className="kv">
        <dt>Chats</dt>
        <dd>{loading ? "…" : `${list.length} open${working ? `, ${working} working now` : ""}`}</dd>
        <dt>Tokens</dt>
        <dd>{loading ? "…" : `${input.toLocaleString()} in · ${output.toLocaleString()} out`}</dd>
        <dt>Cost</dt>
        <dd>{loading ? "…" : (cost ?? (list.length ? "Not reported by this provider" : "—"))}</dd>
      </dl>
    </Section>
  );
}

export function OverviewSection({ bot, onOpen }: { bot: Bot; onOpen: (tab: PanelTab) => void }) {
  const doc = useStoreDoc();
  const { busy, run } = useAction();
  const apps = useQuery({ queryKey: ["apps", "status"], queryFn: () => rpc(appsStatusRpc, {}) });
  const values = doc.data?.values;
  const library = values?.library;
  const groups = (useGroups().data ?? []).filter((group) => group.memberIds.includes(bot.id));
  const limits = botLimits(bot, { local: true, appsConfigured: apps.data?.configured ?? false });
  const skills = bot.skillIds.filter((id) => library?.skills.some((skill) => skill.id === id && skill.enabled));
  const servers = bot.mcpServerIds.filter((id) => library?.mcpServers.some((server) => server.id === id && server.enabled));

  const actions = useBotActions();
  const exportBot = (includeMemory: boolean) => run(includeMemory ? "export-memory" : "export", () => actions.exportBot(bot, includeMemory));
  const duplicate = () => run("duplicate", () => actions.duplicate(bot));

  const setUp = () =>
    run("setup", async () => {
      const { chatId } = await rpc(chatStartRpc, { botId: bot.id, text: SETUP_PROMPT, messageId: newUuid() });
      navigate({ page: "bot", botId: bot.id, chatId });
    });

  const remove = () => run("delete", () => actions.remove(bot));

  return (
    <>
      <Section title="Overview">
        <div className="row" style={{ gap: 12 }}>
          <Avatar avatar={bot.avatar} size={52} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{bot.name}</div>
            {bot.title ? <div className="muted">{bot.title}</div> : null}
          </div>
        </div>
        {bot.description ? <p style={{ margin: 0 }}>{bot.description}</p> : null}
        <dl className="kv">
          <dt>Agent</dt>
          <dd>
            <button type="button" className="btn small ghost" onClick={() => onOpen("model")}>
              {bot.provider || "None"}
              {bot.model ? ` / ${bot.model}` : " / default model"}
            </button>
          </dd>
          <dt>Approval mode</dt>
          <dd>{bot.modeId ?? "Provider default"}</dd>
          <dt>Group chats</dt>
          <dd>
            {groups.length
              ? groups.map((group, index) => (
                  <span key={group.id}>
                    {index ? ", " : ""}
                    <button type="button" className="btn small ghost" onClick={() => navigate({ page: "group", groupId: group.id })}>
                      {group.name}
                    </button>
                  </span>
                ))
              : "None"}
          </dd>
          <dt>Skills</dt>
          <dd>{skills.length}</dd>
          <dt>MCP servers</dt>
          <dd>{servers.length}</dd>
          <dt>Connected apps</dt>
          <dd>{bot.apps.length ? bot.apps.join(", ") : "None"}</dd>
          <dt>Routines</dt>
          <dd>{bot.routines.filter((routine) => routine.enabled).length} active</dd>
        </dl>
      </Section>
      <Section title="Set up with the bot" info="Starts a chat where the bot asks you what it's for, then proposes its own instructions and a starting memory for you to confirm.">
        <div>
          <Button small icon="sparkles" busy={busy === "setup"} disabled={bot.archived} onClick={() => void setUp()}>
            Start
          </Button>
        </div>
      </Section>
      <Section title="What it won't do">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>
      <Usage bot={bot} />
      <Section title="Manage">
        <div className="row wrap">
          <Button small icon="download" busy={busy === "export"} onClick={() => void exportBot(false)}>
            Export
          </Button>
          <Button small icon="download" onClick={() => void exportBot(true)}>
            Export with memory
          </Button>
          <Button small icon="copy" busy={busy === "duplicate"} onClick={() => void duplicate()}>
            Duplicate
          </Button>
          <Button
            small
            icon="sparkles"
            onClick={() => void run("preset", () => actions.saveAsPreset(bot))}
          >
            Save as preset
          </Button>
        </div>
        <div className="row wrap">
          <Button small icon={bot.pinned ? "pinOff" : "pin"} onClick={() => void actions.togglePin(bot)}>
            {bot.pinned ? "Unpin" : "Pin to top"}
          </Button>
          <Button small icon={bot.hidden ? "eye" : "eyeOff"} onClick={() => void actions.toggleHidden(bot)}>
            {bot.hidden ? "Show in sidebar" : "Hide from sidebar"}
          </Button>
          <Button small icon="archive" onClick={() => void actions.toggleArchive(bot)}>
            {bot.archived ? "Restore" : "Archive"}
          </Button>
          <Button small variant="danger" icon="trash" busy={busy === "delete"} onClick={() => void remove()}>
            Delete bot
          </Button>
        </div>
      </Section>
    </>
  );
}
