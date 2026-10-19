import { useCallback, useMemo } from "react";
import { randomSeed } from "../../shared/avatar";
import { newBotId, presetFromBot, type Bot } from "../../shared/bot";
import { exportBotRpc, importBotRpc } from "../../shared/rpc";
import { useFeedback, type MenuItems } from "../components/ui";
import { errorText, rpc } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useCommit } from "../lib/data";
import { navigate } from "../lib/router";
import { useUpdateBot } from "./panel/common";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What can be done to a bot, for its menu in the bot list and its Overview:
 * the actions throw on failure, `menu` builds the list's menu with error toasts.
 */
export function useBotActions() {
  const commit = useCommit();
  const update = useUpdateBot();
  const feedback = useFeedback();

  const exportBot = useCallback(async (bot: Bot, includeMemory: boolean) => {
    const { json } = await rpc(exportBotRpc, { bot, includeMemory });
    download(`${bot.name.replace(/[^\w\- ]+/g, "") || "bot"}.json`, json);
  }, []);

  const duplicate = useCallback(
    async (bot: Bot) => {
      const { json } = await rpc(exportBotRpc, { bot, includeMemory: false });
      const { bot: copy } = await rpc(importBotRpc, { botId: newBotId(), json });
      const now = new Date().toISOString();
      // The bot file leaves out what stays on this machine (folder, grants, apps); a copy here keeps them.
      // A new face tells the two apart.
      const added = {
        ...copy,
        name: `${bot.name} copy`,
        cwd: bot.cwd,
        alwaysAllow: bot.alwaysAllow,
        mcpServerIds: bot.mcpServerIds,
        skillIds: bot.skillIds,
        apps: bot.apps,
        appRules: bot.appRules,
        avatar: { ...bot.avatar, seed: randomSeed() },
        createdAt: now,
        updatedAt: now,
      };
      await commit((current) => ({ ...current, bots: [...current.bots, added] }));
      navigate({ page: "bot", botId: added.id, chatId: null });
    },
    [commit],
  );

  const saveAsPreset = useCallback(
    async (bot: Bot) => {
      await commit((current) => ({ ...current, presets: [...(current.presets ?? []), presetFromBot(current.bots.find((entry) => entry.id === bot.id) ?? bot)] }));
      feedback.toast(`Saved ${bot.name} as a preset. It's under New bot.`);
    },
    [commit, feedback],
  );

  const rename = useCallback(
    async (bot: Bot) => {
      const name = await feedback.prompt({ title: "Rename bot", label: "Name", value: bot.name, action: "Rename" });
      if (name && name !== bot.name) await update(bot.id, { name });
    },
    [feedback, update],
  );

  /** Deletes the bot after asking; returns whether it did. */
  const remove = useCallback(
    async (bot: Bot): Promise<boolean> => {
      const yes = await feedback.confirm({ title: `Delete ${bot.name}?`, body: "Its settings and routines go, and it stops taking part in its group chats. Its chat history and memory files stay on disk.", action: "Delete", danger: true });
      if (!yes) return false;
      await commit((current) => {
        const ui = current.ui;
        return {
          ...current,
          bots: current.bots.filter((entry) => entry.id !== bot.id),
          history: current.history.filter((entry) => entry.botId !== bot.id),
          ...(ui
            ? {
                ui: {
                  ...ui,
                  collapsed: ui.collapsed.filter((id) => id !== bot.id),
                  pinnedChats: ui.pinnedChats.filter((pin) => pin.botId !== bot.id),
                  chatOrder: Object.fromEntries(Object.entries(ui.chatOrder).filter(([id]) => id !== bot.id)),
                },
              }
            : {}),
        };
      });
      navigate({ page: "home" });
      return true;
    },
    [commit, feedback],
  );

  const togglePin = useCallback((bot: Bot) => update(bot.id, { pinned: !bot.pinned }, false), [update]);
  const toggleArchive = useCallback((bot: Bot) => update(bot.id, { archived: !bot.archived }), [update]);
  /** Hide from sidebar: off the list, still working; Show in sidebar brings it back. */
  const toggleHidden = useCallback(
    async (bot: Bot) => {
      const saved = await update(bot.id, { hidden: !bot.hidden }, false);
      if (saved && !bot.hidden) feedback.toast(`${bot.name} is under Hidden bots at the bottom of the list. Its routines keep running.`);
      return saved;
    },
    [update, feedback],
  );

  /** The bot list's menu; `move` and `openSettings` come from the list, which knows the order and the panel. */
  const menu = useCallback(
    (bot: Bot, extra: { openSettings: () => void; move?: { up: (() => void) | undefined; down: (() => void) | undefined } }): MenuItems => {
      const attempt = (work: () => Promise<unknown>, failed: string) => () => void work().catch((error: unknown) => feedback.error(`${failed}: ${errorText(error)}`));
      return [
        { label: "Open bot settings", icon: "settings", onSelect: extra.openSettings },
        { label: bot.pinned ? "Unpin" : "Pin to top", icon: bot.pinned ? "pinOff" : "pin", onSelect: () => void togglePin(bot) },
        ...(extra.move
          ? [
              { label: "Move up", icon: "arrowUp" as const, disabled: !extra.move.up, onSelect: () => extra.move?.up?.() },
              { label: "Move down", icon: "arrowDown" as const, disabled: !extra.move.down, onSelect: () => extra.move?.down?.() },
            ]
          : []),
        "divider",
        { label: "Rename bot", icon: "edit", onSelect: attempt(() => rename(bot), "Couldn't rename") },
        { label: "Duplicate", icon: "copy", onSelect: attempt(() => duplicate(bot), "Couldn't duplicate") },
        { label: "Save as preset", icon: "sparkles", onSelect: attempt(() => saveAsPreset(bot), "Couldn't save the preset") },
        { label: "Export", icon: "download", onSelect: attempt(() => exportBot(bot, false), "Couldn't export") },
        {
          label: "Copy bot ID",
          icon: "copy",
          onSelect: () =>
            void copyText(bot.id).then(
              () => feedback.toast("Bot ID copied"),
              () => feedback.error("Couldn't copy."),
            ),
        },
        "divider",
        { label: bot.hidden ? "Show in sidebar" : "Hide from sidebar", icon: bot.hidden ? "eye" : "eyeOff", onSelect: () => void toggleHidden(bot) },
        { label: bot.archived ? "Unarchive bot" : "Archive bot", icon: "archive", onSelect: () => void toggleArchive(bot) },
        { label: "Delete bot", icon: "trash", danger: true, onSelect: attempt(() => remove(bot), "Couldn't delete") },
      ];
    },
    [duplicate, exportBot, feedback, remove, rename, saveAsPreset, toggleArchive, toggleHidden, togglePin],
  );

  return useMemo(
    () => ({ exportBot, duplicate, saveAsPreset, rename, remove, togglePin, toggleHidden, toggleArchive, menu }),
    [exportBot, duplicate, saveAsPreset, rename, remove, togglePin, toggleHidden, toggleArchive, menu],
  );
}
