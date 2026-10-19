import { useEffect, useRef, useState } from "react";
import { searchRpc } from "../../../shared/rpc";
import { searchTerms } from "../../../shared/search";
import { Icon } from "../../components/icons";
import { IconButton } from "../../components/ui";
import { rpc } from "../../lib/api";

/**
 * Find in this chat (Cmd/Ctrl+F): the chat's messages with every word, from its whole
 * history. It opens at the newest match; Enter goes to the next older one, Shift+Enter back.
 */
export function FindBar({ chatId, signal, onShow, onTerms, onClose }: { chatId: string; signal: number; onShow: (seq: number) => void; onTerms: (terms: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<number[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const show = useRef(onShow);
  show.current = onShow;
  const terms = useRef(onTerms);
  terms.current = onTerms;

  // Cmd/Ctrl+F again while it's open selects what's typed.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [signal]);

  useEffect(() => {
    const words = searchTerms(query);
    terms.current(words);
    if (words.length === 0) {
      setHits(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      setBusy(true);
      rpc(searchRpc, { query: query.trim().slice(0, 200), chatId, limit: 200 })
        .then(({ hits: found }) => {
          if (stale) return;
          const seqs = [...new Set(found.map((hit) => hit.seq))].sort((a, b) => a - b);
          setHits(seqs);
          setIndex(seqs.length - 1);
          if (seqs.length) show.current(seqs[seqs.length - 1]!);
        })
        .catch(() => !stale && setHits([]))
        .finally(() => !stale && setBusy(false));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [chatId, query]);

  const go = (step: -1 | 1) => {
    if (!hits?.length) return;
    const next = (index + step + hits.length) % hits.length;
    setIndex(next);
    show.current(hits[next]!);
  };

  return (
    <div className="find-bar" role="search">
      <Icon name="search" size={14} />
      <input
        ref={input}
        className="grow"
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            go(event.shiftKey ? 1 : -1);
          }
        }}
      />
      {busy ? <span className="spinner small" /> : hits ? <span className="hint find-count">{hits.length ? `${index + 1} of ${hits.length}` : "No matches"}</span> : null}
      <IconButton icon="arrowUp" size={14} title="Older match (Enter)" disabled={!hits?.length} onClick={() => go(-1)} />
      <IconButton icon="arrowDown" size={14} title="Newer match (Shift+Enter)" disabled={!hits?.length} onClick={() => go(1)} />
      <IconButton icon="x" size={14} title="Close (Esc)" onClick={onClose} />
    </div>
  );
}
