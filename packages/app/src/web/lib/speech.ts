import { useSyncExternalStore } from "react";
import { speechChunks } from "../../shared/speech";

// Replies read aloud with the browser's own voices, one reading at a time:
// starting another stops the last.

const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;

export const canSpeak = !!synth;

let speaking: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Reads `text` with the named voice (the default one when this browser lacks it). `key` identifies the reading for useSpeaking. */
export function speak(key: string, text: string, voiceName: string | null): void {
  if (!synth) return;
  synth.cancel();
  const voice = voiceName ? synth.getVoices().find((entry) => entry.name === voiceName) : undefined;
  const chunks = speechChunks(text);
  if (chunks.length === 0) return;
  const done = () => {
    if (speaking !== key) return;
    speaking = null;
    changed();
  };
  speaking = key;
  changed();
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.onerror = done;
    if (index === chunks.length - 1) utterance.onend = done;
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  synth?.cancel();
  speaking = null;
  changed();
}

/** Whether the reading `key` is going on. */
export function useSpeaking(key: string): boolean {
  return useSyncExternalStore(subscribe, () => speaking === key);
}
