import { useEffect } from "react";
import type { Bot } from "../../../shared/bot";
import { IconButton } from "../../components/ui";
import { useLocalState } from "../../lib/local";
import { AccessSection } from "./AccessSection";
import { HistorySection } from "./HistorySection";
import { IdentitySection } from "./IdentitySection";
import { InstructionsSection } from "./InstructionsSection";
import { MemorySection } from "./MemorySection";
import { ModelSection } from "./ModelSection";
import { OverviewSection } from "./OverviewSection";
import { RoutinesSection } from "./RoutinesSection";
import { SkillsSection } from "./SkillsSection";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "identity", label: "Identity" },
  { id: "soul", label: "Soul" },
  { id: "model", label: "Model" },
  { id: "skills", label: "Skills" },
  { id: "access", label: "Access" },
  { id: "routines", label: "Routines" },
  { id: "memory", label: "Memory" },
  { id: "history", label: "History" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const TAB_KEY = "pocket.panelTab";
const OPEN_EVENT = "pocket:panel-open";
/** An element to show once the panel has it: a routine the palette picked. */
let pendingTarget: string | null = null;

/** Opens a tab of the bot panel (the open one, or the next one to open) and shows the element with id `target` in it. */
export function openPanelTab(tab: TabId, target?: string): void {
  try {
    window.localStorage.setItem(TAB_KEY, JSON.stringify(tab));
  } catch {
    // Storage blocked: an open panel still hears the event.
  }
  pendingTarget = target ?? null;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: tab }));
}

/** A bot's settings, beside its chats. */
export function BotPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [tab, setTab] = useLocalState<TabId>(TAB_KEY, "overview");
  useEffect(() => {
    const open = (event: Event) => setTab((event as CustomEvent<TabId>).detail);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, [setTab]);
  useEffect(() => {
    const element = pendingTarget ? document.getElementById(pendingTarget) : null;
    if (!element) return;
    pendingTarget = null;
    element.scrollIntoView({ block: "center" });
    element.classList.add("flash");
    setTimeout(() => element.classList.remove("flash"), 1500);
  });
  return (
    <aside className="panel">
      <div className="topbar">
        <div className="title">Bot settings</div>
        <IconButton icon="x" title="Close settings" onClick={onClose} />
      </div>
      <div className="panel-tabs">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" className={entry.id === tab ? "active" : ""} onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        {tab === "overview" ? <OverviewSection bot={bot} onOpen={setTab} /> : null}
        {tab === "identity" ? <IdentitySection bot={bot} /> : null}
        {tab === "soul" ? <InstructionsSection bot={bot} /> : null}
        {tab === "model" ? <ModelSection bot={bot} /> : null}
        {tab === "skills" ? <SkillsSection bot={bot} /> : null}
        {tab === "access" ? <AccessSection bot={bot} /> : null}
        {tab === "routines" ? <RoutinesSection bot={bot} /> : null}
        {tab === "memory" ? <MemorySection bot={bot} /> : null}
        {tab === "history" ? <HistorySection bot={bot} /> : null}
      </div>
    </aside>
  );
}

export type PanelTab = TabId;
