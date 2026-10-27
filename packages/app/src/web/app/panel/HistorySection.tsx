import type { Bot } from "../../../shared/bot";
import { relativeTime } from "../../../shared/time";
import { Avatar } from "../../components/Avatar";
import { Button, useFeedback } from "../../components/ui";
import { useStoreDoc } from "../../lib/data";
import { Section, useUpdateBot } from "./common";

function differences(before: Bot, after: Bot): string[] {
  const fields: [keyof Bot, string][] = [
    ["name", "name"],
    ["title", "role"],
    ["description", "about"],
    ["soul", "instructions"],
    ["provider", "provider"],
    ["model", "model"],
    ["modeId", "approval mode"],
    ["thinkingOptionId", "thinking"],
    ["contactBots", "contact other bots"],
    ["memoryAutoWrite", "memory writing"],
    ["includeRecentWork", "recent work"],
    ["skillIds", "skills"],
    ["mcpServerIds", "MCP servers"],
    ["alwaysAllow", "tool grants"],
    ["apps", "apps"],
    ["routines", "routines"],
    ["playbooks", "playbooks"],
    ["avatar", "avatar"],
    ["cwd", "folder"],
  ];
  return fields.filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([, label]) => label);
}

/** The bot's earlier settings, newest first; restoring one records the current ones too. */
export function HistorySection({ bot }: { bot: Bot }) {
  const doc = useStoreDoc();
  const update = useUpdateBot();
  const feedback = useFeedback();
  const entries = (doc.data?.values.history ?? []).filter((entry) => entry.botId === bot.id).reverse();
  return (
    <Section title="History" info="Earlier settings of this bot, kept for its last 20 edits (edits within a minute count as one).">
      {entries.length === 0 ? <div className="hint">No earlier settings yet.</div> : null}
      {entries.map((entry) => {
        const changed = differences(entry.snapshot, bot);
        return (
          <div key={entry.at} className="row">
            <Avatar avatar={entry.snapshot.avatar} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small">{relativeTime(entry.at)}</div>
              <div className="hint truncate">{changed.length ? `Differs in ${changed.join(", ")}` : "Same as now"}</div>
            </div>
            <Button
              small
              disabled={changed.length === 0}
              onClick={async () => {
                if (!(await feedback.confirm({ title: "Restore these settings?", body: `The bot's ${changed.join(", ")} go back to how they were ${relativeTime(entry.at)}.`, action: "Restore" }))) return;
                await update(bot.id, () => ({ ...entry.snapshot, id: bot.id }), "always");
              }}
            >
              Restore
            </Button>
          </div>
        );
      })}
    </Section>
  );
}
