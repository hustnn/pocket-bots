import { useCallback, useState } from "react";
import { storeResetRpc } from "../../shared/rpc";
import { Button, useFeedback } from "../components/ui";
import { errorText, rpc } from "../lib/api";
import { useServerEvents, useStatus, useStoreDoc } from "../lib/data";
import { useShortcut } from "../lib/keys";
import { useLocalState } from "../lib/local";
import { navigate, useRoute } from "../lib/router";
import { BotPanel, openPanelTab } from "./panel/BotPanel";
import { ChatView } from "./chat/ChatView";
import { CommandPalette } from "./CommandPalette";
import { GroupView } from "./group/GroupView";
import { LibraryView } from "./library/LibraryView";
import { NewBotDialog } from "./NewBotDialog";
import { SettingsView } from "./SettingsView";
import { Sidebar } from "./Sidebar";
import { Splash } from "./Splash";
import { TeamDialog } from "./team/TeamDialogs";
import { TeamView } from "./team/TeamView";

export function App() {
  useServerEvents();
  const route = useRoute();
  const doc = useStoreDoc();
  const status = useStatus();
  const [panelOpen, setPanelOpen] = useLocalState("pocket.panel", true);
  const [creating, setCreating] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [palette, setPalette] = useState(false);
  const feedback = useFeedback();
  useShortcut("k", () => setPalette((open) => !open));
  const openRoutine = useCallback(
    (botId: string, routineId: string) => {
      openPanelTab("routines", `routine-${routineId}`);
      setPanelOpen(true);
      navigate({ page: "bot", botId, chatId: null });
    },
    [setPanelOpen],
  );

  /** Sets the unreadable bots file aside and starts an empty one. */
  const resetBots = async () => {
    const yes = await feedback.confirm({
      title: "Reset bots?",
      body: "The bot list starts empty. The unreadable file is kept next to it as bots.json.broken-<time>, so nothing is lost; memory folders and chats aren't touched.",
      action: "Reset",
      danger: true,
    });
    if (!yes) return;
    try {
      const { backup } = await rpc(storeResetRpc, {});
      await doc.refetch();
      feedback.toast(backup ? `The old file is at ${backup}` : "Started an empty bot list");
    } catch (error) {
      feedback.error(errorText(error));
    }
  };

  if (doc.isError) {
    return (
      <div className="splash">
        <h1>pocket-bots can't load its bots</h1>
        <p className="muted" style={{ maxWidth: 640 }}>
          {doc.error instanceof Error ? doc.error.message : String(doc.error)}
        </p>
        <div className="row">
          <Button onClick={() => void doc.refetch()}>Try again</Button>
          <Button variant="danger" onClick={() => void resetBots()}>
            Reset bots
          </Button>
        </div>
      </div>
    );
  }

  const values = doc.data?.values;
  const bot = route.page === "bot" ? (values?.bots.find((entry) => entry.id === route.botId) ?? null) : null;
  const showMain = route.page !== "home";

  let main;
  if (route.page === "bot") {
    main = bot ? (
      <ChatView key={bot.id} bot={bot} chatId={route.chatId} {...(route.at ? { at: route.at } : {})} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen(!panelOpen)} />
    ) : (
      <div className="splash">{doc.isPending ? <span className="spinner" /> : <p className="muted">That bot no longer exists.</p>}</div>
    );
  } else if (route.page === "library") main = <LibraryView tab={route.tab} />;
  else if (route.page === "team") main = <TeamView key={route.teamId} teamId={route.teamId} />;
  else if (route.page === "group") main = <GroupView key={route.groupId} groupId={route.groupId} {...(route.at ? { at: route.at } : {})} {...(route.thread ? { atThread: route.thread } : {})} />;
  else if (route.page === "settings") main = <SettingsView status={status.data ?? null} />;
  else main = <Splash onNewBot={() => setCreating(true)} onNewTeam={() => setCreatingTeam(true)} />;

  return (
    <div className={`app${showMain ? " show-main" : ""}`}>
      <Sidebar
        route={route}
        onSearch={() => setPalette(true)}
        onNewBot={() => setCreating(true)}
        onNewTeam={() => setCreatingTeam(true)}
        onOpenSettings={(botId) => {
          setPanelOpen(true);
          navigate({ page: "bot", botId, chatId: route.page === "bot" && route.botId === botId ? route.chatId : null });
        }}
      />
      <main className="main">{main}</main>
      {bot && panelOpen ? <BotPanel key={bot.id} bot={bot} onClose={() => setPanelOpen(false)} /> : <div />}
      {creating ? (
        <NewBotDialog
          onClose={() => setCreating(false)}
          onCreated={(botId) => {
            setCreating(false);
            setPanelOpen(true);
            navigate({ page: "bot", botId, chatId: null });
          }}
        />
      ) : null}
      {palette ? <CommandPalette onClose={() => setPalette(false)} onOpenRoutine={openRoutine} /> : null}
      {creatingTeam ? <TeamDialog onClose={() => setCreatingTeam(false)} onSaved={(teamId) => navigate({ page: "team", teamId })} /> : null}
    </div>
  );
}
