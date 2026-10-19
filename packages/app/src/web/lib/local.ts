import { useCallback, useState } from "react";

/** What a message sent while a bot works does: "steer", "interrupt" or "queue" (Settings → Chats). */
export const SEND_BEHAVIOR_KEY = "pocket.sendBehavior";

/** Per-browser UI state (a remembered tab, an open panel); falls back to memory when storage is blocked. */
export function useLocalState<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage blocked; the value still holds for this session.
      }
    },
    [key],
  );
  return [value, update];
}
