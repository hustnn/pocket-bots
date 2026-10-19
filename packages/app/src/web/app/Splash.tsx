import { useMemo } from "react";
import { SPLASH_LINEUP, spriteAvatar } from "../../shared/avatar";
import { POCKET_VERSION } from "../../shared/version";
import { useDark } from "../components/Avatar";
import { Button } from "../components/ui";
import { useProviders, useStoreDoc } from "../lib/data";
import { MOD } from "../lib/keys";
import { navigate } from "../lib/router";

function Lineup() {
  const dark = useDark();
  const sprites = useMemo(() => SPLASH_LINEUP.map((entry) => spriteAvatar(entry.sprite, entry.palette, entry.accent, { dark })), [dark]);
  return (
    <div className="row" style={{ gap: 10 }}>
      {sprites.map((sprite, index) => (
        <svg key={index} width={52} height={52} viewBox="0 0 24 24" shapeRendering="crispEdges" style={{ borderRadius: 14 }} aria-hidden="true">
          <rect width={24} height={24} fill={sprite.background} />
          {sprite.rows.map((runs, y) => runs.map((run) => (run.color ? <rect key={`${y}-${run.x}`} x={run.x} y={y} width={run.width} height={1.02} fill={run.color} /> : null)))}
        </svg>
      ))}
    </div>
  );
}

export function Splash({ onNewBot, onNewGroup }: { onNewBot: () => void; onNewGroup: () => void }) {
  const doc = useStoreDoc();
  const providers = useProviders();
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  const first = bots.find((bot) => !bot.hidden) ?? bots[0];
  const ready = (providers.data?.entries ?? []).filter((entry) => entry.status === "ready");
  return (
    <div className="splash">
      <Lineup />
      <h1>Pocket Bots</h1>
      <p className="muted" style={{ maxWidth: 480, margin: 0 }}>
        Personal bots on your own coding agents (Claude Code, Codex, OpenCode, Pi, Grok Build), each on its own login. Give each bot instructions, a model, memory, skills and tools, then chat with it, let it run routines, or put a few bots in a group chat to work together.
      </p>
      {providers.data && ready.length === 0 ? (
        <div className="notice warning" style={{ maxWidth: 520 }}>
          No agent CLI is ready. Install one and log in (for example, run <span className="mono">claude</span> once), then reload.
        </div>
      ) : null}
      <div className="row">
        <Button variant="primary" icon="plus" onClick={onNewBot}>
          New bot
        </Button>
        {first ? (
          <Button icon="bot" onClick={() => navigate({ page: "bot", botId: first.id, chatId: null })}>
            Open {first.name}
          </Button>
        ) : null}
        {bots.length >= 2 ? (
          <Button icon="messages" onClick={onNewGroup}>
            New group chat
          </Button>
        ) : null}
      </div>
      {bots.length ? <div className="hint">Press {MOD}K to jump to a bot, group, chat or routine, or to search messages.</div> : null}
      <div className="hint">v{POCKET_VERSION}</div>
    </div>
  );
}
