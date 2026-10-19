import { useEffect, useRef } from "react";

/** The shortcut modifier as the keyboard shows it: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

/** Cmd (Mac) or Ctrl plus `key`, and no other modifier. */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === key;
}

/** Runs `run` on Cmd/Ctrl+`key` anywhere on the page, in place of what the browser would do. */
export function useShortcut(key: string, run: (() => void) | null): void {
  const latest = useRef(run);
  latest.current = run;
  const enabled = run !== null;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcut(event, key) || !latest.current) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled]);
}
