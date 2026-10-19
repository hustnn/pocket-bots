import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../lib/clipboard";
import { Icon, type IconName } from "./icons";

// ---------------------------------------------------------------- buttons

export function Button({
  children,
  onClick,
  variant,
  small,
  disabled,
  busy,
  icon,
  title,
  type = "button",
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "danger" | "ghost";
  small?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={["btn", variant, small ? "small" : ""].filter(Boolean).join(" ")} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={small ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, onClick, title, disabled, size = 16 }: { icon: IconName; onClick?: (event: React.MouseEvent) => void; title: string; disabled?: boolean; size?: number }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button key={option.value} type="button" className={option.value === value ? "active" : ""} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? <div className="error-text">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

/** A text input that saves on blur or Enter, so typing doesn't write on every key. */
export function CommitInput({ value, onCommit, placeholder, multiline, mono, rows }: { value: string; onCommit: (next: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean; rows?: number }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className={`textarea${mono ? " mono" : ""}`}
        value={draft}
        rows={rows ?? 6}
        placeholder={placeholder}
        onFocus={() => (focused.current = true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------------------------------------------------------------- overlays

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div style={{ flex: 1 }}>{title}</div>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuEntry {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** A short value shown at the right, like a setting's current choice. */
  trailing?: string;
  onSelect: () => void;
}

export type MenuItems = (MenuEntry | "divider")[];

/** A small menu of actions at `anchor`: a button's box, or the pointer for a right-click. */
export function Menu({ anchor, entries, align = "end", onClose }: { anchor: DOMRect; entries: MenuItems; align?: "start" | "end"; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const preferred = align === "end" ? anchor.right - rect.width : anchor.left;
    const left = Math.min(Math.max(8, preferred), window.innerWidth - rect.width - 8);
    const below = anchor.bottom + 4;
    const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, anchor.top - rect.height - 4) : below;
    setPosition({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      role="menu"
      className="menu"
      style={position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) =>
        entry === "divider" ? (
          <hr key={index} />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={entry.danger ? "danger" : ""}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon ? <Icon name={entry.icon} size={14} /> : null}
            <span className="menu-label">{entry.label}</span>
            {entry.trailing ? <span className="menu-trailing">{entry.trailing}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A button that opens a small menu of actions; `entries` may be built when it opens. */
export function MenuButton({ entries, icon = "more", title = "More", size }: { entries: MenuItems | (() => MenuItems); icon?: IconName; title?: string; size?: number }) {
  const [open, setOpen] = useState<{ anchor: DOMRect; entries: MenuItems } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      <IconButton
        icon={icon}
        title={title}
        size={size}
        onClick={(event) => {
          event.stopPropagation();
          setOpen({ anchor: (event.currentTarget as HTMLElement).getBoundingClientRect(), entries: typeof entries === "function" ? entries() : entries });
        }}
      />
      {open ? <Menu anchor={open.anchor} entries={open.entries} onClose={close} /> : null}
    </>
  );
}

/** A menu opened at the pointer, for right-clicks: call `open` from onContextMenu and render `menu`. */
export function useContextMenu(): { open: (event: React.MouseEvent, entries: MenuItems) => void; menu: ReactNode } {
  const [state, setState] = useState<{ anchor: DOMRect; entries: MenuItems } | null>(null);
  const open = useCallback((event: React.MouseEvent, entries: MenuItems) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ anchor: new DOMRect(event.clientX, event.clientY, 0, 0), entries });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { open, menu: state ? <Menu anchor={state.anchor} entries={state.entries} align="start" onClose={close} /> : null };
}

// ---------------------------------------------------------------- toasts and confirms

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

interface PromptInput {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  action: string;
  /** An empty answer is allowed (it comes back as ""). */
  optional?: boolean;
}

interface Feedback {
  toast: (text: string) => void;
  error: (text: string) => void;
  confirm: (input: { title: string; body?: ReactNode; action: string; danger?: boolean }) => Promise<boolean>;
  /** Asks for a line of text; null when cancelled. */
  prompt: (input: PromptInput) => Promise<string | null>;
}

function PromptDialog({ input, onAnswer }: { input: PromptInput; onAnswer: (value: string | null) => void }) {
  const [value, setValue] = useState(input.value ?? "");
  const ready = input.optional || !!value.trim();
  const submit = () => ready && onAnswer(value.trim());
  return (
    <Modal
      title={input.title}
      onClose={() => onAnswer(null)}
      footer={
        <>
          <Button onClick={() => onAnswer(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={submit}>
            {input.action}
          </Button>
        </>
      }
    >
      <Field label={input.label ?? ""}>
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={input.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
          }}
        />
      </Field>
    </Modal>
  );
}

const FeedbackContext = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [question, setQuestion] = useState<{ title: string; body?: ReactNode; action: string; danger?: boolean; resolve: (yes: boolean) => void } | null>(null);
  const [asking, setAsking] = useState<{ input: PromptInput; resolve: (value: string | null) => void } | null>(null);
  const next = useRef(1);
  const push = useCallback((text: string, error: boolean) => {
    const id = next.current++;
    setToasts((current) => [...current, { id, text, error }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), error ? 6000 : 3000);
  }, []);
  const value = useRef<Feedback>({
    toast: (text) => push(text, false),
    error: (text) => push(text, true),
    confirm: (input) => new Promise((resolve) => setQuestion({ ...input, resolve })),
    prompt: (input) => new Promise((resolve) => setAsking({ input, resolve })),
  });
  const answer = (yes: boolean) => {
    question?.resolve(yes);
    setQuestion(null);
  };
  return (
    <FeedbackContext.Provider value={value.current}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.error ? " error" : ""}`}>
            {toast.text}
          </div>
        ))}
      </div>
      {question ? (
        <Modal
          title={question.title}
          onClose={() => answer(false)}
          footer={
            <>
              <Button onClick={() => answer(false)}>Cancel</Button>
              <Button variant={question.danger ? "danger" : "primary"} onClick={() => answer(true)}>
                {question.action}
              </Button>
            </>
          }
        >
          {question.body ?? null}
        </Modal>
      ) : null}
      {asking ? (
        <PromptDialog
          input={asking.input}
          onAnswer={(value) => {
            asking.resolve(value);
            setAsking(null);
          }}
        />
      ) : null}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error("useFeedback needs a FeedbackProvider");
  return feedback;
}

/** Runs an async action with a busy flag and an error toast. */
export function useAction() {
  const feedback = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, work: () => Promise<unknown>, success?: string) => {
      setBusy(key);
      try {
        await work();
        if (success) feedback.toast(success);
        return true;
      } catch (error) {
        feedback.error(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [feedback],
  );
  return { busy, run };
}

export function CopyButton({ text, title = "Copy" }: { text: string; title?: string }) {
  const feedback = useFeedback();
  return (
    <IconButton
      icon="copy"
      title={title}
      size={14}
      onClick={() => {
        void copyText(text).then(
          () => feedback.toast("Copied"),
          () => feedback.error("Couldn't copy."),
        );
      }}
    />
  );
}
