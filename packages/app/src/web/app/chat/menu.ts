import { useCallback } from "react";
import { chatArchiveRpc, chatTranscriptRpc } from "../../../shared/rpc";
import { useFeedback, type MenuEntry } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { navigate, useRoute } from "../../lib/router";

export interface ChatMenuTarget {
  botId: string;
  chatId: string;
  /** The chat's working folder, for Copy path. */
  cwd?: string | null;
  /** After it's archived (the bot list drops its pin). */
  onArchived?: () => void;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A chat's actions, for the chat header and its row in the bot list: copy its
 * id, folder or transcript, export it, archive it.
 * `extra` entries (pin, move) go first.
 */
export function useChatMenu(): (target: ChatMenuTarget, extra?: (MenuEntry | "divider")[]) => (MenuEntry | "divider")[] {
  const feedback = useFeedback();
  const route = useRoute();
  const openChatId = route.page === "bot" ? route.chatId : null;

  return useCallback(
    (target, extra = []) => {
      const copy = (text: string, done: string) =>
        void copyText(text).then(
          () => feedback.toast(done),
          () => feedback.error("Couldn't copy."),
        );
      const transcript = async () => rpc(chatTranscriptRpc, { chatId: target.chatId });
      const archive = async () => {
        if (!(await feedback.confirm({ title: "Archive this chat?", body: "It leaves the chat list. The conversation is kept, and search still finds it.", action: "Archive", danger: true }))) return;
        try {
          await rpc(chatArchiveRpc, { chatId: target.chatId });
          target.onArchived?.();
          if (openChatId === target.chatId) navigate({ page: "bot", botId: target.botId, chatId: null });
        } catch (error) {
          feedback.error(errorText(error));
        }
      };
      const entries: (MenuEntry | "divider")[] = [];
      if (extra.length) entries.push(...extra, "divider");
      entries.push(
        { label: "Copy chat ID", icon: "copy", onSelect: () => copy(target.chatId, "Chat ID copied") },
        ...(target.cwd ? [{ label: "Copy path", icon: "copy" as const, onSelect: () => copy(target.cwd!, "Path copied") }] : []),
        {
          label: "Copy transcript",
          icon: "copy",
          onSelect: () =>
            void transcript().then(
              ({ markdown }) => copy(markdown, "Transcript copied"),
              (error: unknown) => feedback.error(errorText(error)),
            ),
        },
        {
          label: "Export transcript",
          icon: "download",
          onSelect: () =>
            void transcript().then(
              ({ title, markdown }) => download(`${title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "chat"}.md`, markdown),
              (error: unknown) => feedback.error(errorText(error)),
            ),
        },
        "divider",
        { label: "Archive chat", icon: "archive", danger: true, onSelect: () => void archive() },
      );
      return entries;
    },
    [feedback, openChatId],
  );
}
